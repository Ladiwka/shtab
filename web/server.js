// ШТАБ · веб-пульт — тот же кокпит с телефона/планшета (комп раздаёт по своей сети/VPN).
// ВЫКЛЮЧЕН по умолчанию, включается кнопкой в приложении. Защита: длинный токен (в ссылке →
// в cookie), запросы без токена не проходят вообще; слушаем ТОЛЬКО локальную сеть/VPN,
// наружу в интернет ничего не открываем. Терминалы проксируются на локальный сайдкар (ws+http),
// его собственный токен телефону не отдаём — подставляем на прокси.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const WEB_DIR = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon',
};

let srv = null;
let token = '';
let port = 0;
let api = null;          // набор функций из main.js (та же логика, что у окна)
let termInfo = () => ({ available: false });

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
    }
  }
  return out;
}

function cookieToken(req) {
  const c = String(req.headers.cookie || '');
  const m = c.match(/(?:^|;\s*)shtab_t=([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}
function urlToken(u) {
  const m = String(u).match(/[?&]t=([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}
function timingSafeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function authed(req) {
  if (!token) return false;
  const t = urlToken(req.url) || cookieToken(req);
  try { return timingSafeEq(t, token); } catch (_) { return false; }
}
// анти-DNS-rebinding: принимаем только запросы с Host = наш реальный адрес/localhost.
// Иначе вредный сайт, чей домен резолвится в наш IP, гонял бы браузер жертвы к пульту.
function hostAllowed(req) {
  const hostname = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  return lanAddresses().some((a) => a.address === hostname);
}

// CSP: скрипты только свои (не 'unsafe-inline' — mobile.html без инлайна), стили свои + inline
// (динамические стили/xterm), кадры только свои (терминал в iframe того же источника).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'";
function send(res, code, body, type, extra) {
  const h = {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'SAMEORIGIN',   // от кликджекинга (свой iframe терминала разрешён)
  };
  if (extra) Object.assign(h, extra);
  res.writeHead(code, h);
  res.end(body);
}
function sendJson(res, obj) { send(res, 200, JSON.stringify(obj), MIME['.json']); }

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > limit) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

// ─────────── прокси терминала на локальный сайдкар (http + websocket) ───────────
function proxyHttp(req, res, rest) {
  const info = termInfo();
  if (!info || !info.available) return send(res, 503, 'терминал недоступен');
  const sep = rest.includes('?') ? '&' : '?';
  const target = `${rest}${sep}token=${info.token}`;
  const p = http.request({ host: '127.0.0.1', port: info.port, path: target, method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${info.port}` } }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  p.on('error', () => send(res, 502, 'сайдкар не отвечает'));
  req.pipe(p);
}

function proxyWs(req, socket, head, rest) {
  const info = termInfo();
  if (!info || !info.available) return socket.destroy();
  const sep = rest.includes('?') ? '&' : '?';
  const target = `${rest}${sep}token=${info.token}`;
  const up = net.connect(info.port, '127.0.0.1', () => {
    const headers = Object.entries(req.headers)
      .filter(([k]) => k.toLowerCase() !== 'host' && k.toLowerCase() !== 'cookie')
      .map(([k, v]) => `${k}: ${v}`).join('\r\n');
    up.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\n${headers}\r\n\r\n`);
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

// ─────────── маршруты ───────────
async function handle(req, res) {
  if (!hostAllowed(req)) return send(res, 403, 'ШТАБ: неверный адрес (защита от подмены).');
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  // заход по ссылке с токеном (?t=…): кладём токен в HttpOnly-cookie и РЕДИРЕКТИМ на чистый '/'
  // — так токен исчезает из адресной строки/истории/логов, а дальше всё ходит по cookie.
  if (p === '/' && urlToken(req.url) && timingSafeEq(urlToken(req.url), token)) {
    return send(res, 302, 'ok', 'text/plain', {
      'Set-Cookie': `shtab_t=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
      'Location': '/',
    });
  }
  if (!authed(req)) {
    return send(res, 401, 'ШТАБ: нужна ссылка с кодом доступа (открой QR из приложения на компе)');
  }

  // статика мобильного пульта
  if (p === '/' || p === '/index.html') {
    return send(res, 200, fs.readFileSync(path.join(WEB_DIR, 'mobile.html'), 'utf8'), MIME['.html']);
  }
  if (/^\/(mobile\.js|mobile\.css|vendor\/[a-z.\-]+\.js)$/.test(p)) {
    const f = path.join(WEB_DIR, p.slice(1));
    if (!f.startsWith(WEB_DIR)) return send(res, 403, 'нельзя');
    try { return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream'); }
    catch (_) { return send(res, 404, 'нет файла'); }
  }
  // обои проектов (для плиток)
  if (p.startsWith('/wall/')) {
    const f = path.join(WEB_DIR, '..', 'renderer', 'assets', 'wall', path.basename(p));
    try { return send(res, 200, fs.readFileSync(f), 'image/jpeg'); } catch (_) { return send(res, 404, ''); }
  }

  // терминал (прокси на сайдкар; его токен телефону не даём)
  if (p === '/term/' || p === '/term') return proxyHttp(req, res, '/' + (u.search || ''));
  if (p.startsWith('/term/')) return proxyHttp(req, res, p.replace(/^\/term/, '') + (u.search || ''));

  // ─────── API ───────
  try {
    if (p === '/api/projects') return sendJson(res, await api.listProjects());
    if (p === '/api/overview') return sendJson(res, await api.overview(u.searchParams.get('dir')));
    if (p === '/api/status') return sendJson(res, await api.getStatus(u.searchParams.get('id'), u.searchParams.get('dir')));
    if (p === '/api/tails') return sendJson(res, await api.tails());
    if (p === '/api/agents') return sendJson(res, await api.agentList());
    if (p === '/api/agent/diff') return sendJson(res, await api.agentDiff(u.searchParams.get('id')));
    if (p === '/api/agent/run' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      return sendJson(res, await api.agentRun(b.id, b.dir, b.prompt));
    }
    if (p === '/api/agent/accept' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      return sendJson(res, await api.agentAccept(b.id));
    }
    if (p === '/api/agent/reject' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      return sendJson(res, await api.agentReject(b.id));
    }
    if (p === '/api/notes' && req.method === 'GET') return sendJson(res, { text: await api.loadNotes() });
    if (p === '/api/notes' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      await api.saveNotes(String(b.text || ''));
      return sendJson(res, { ok: true });
    }
    if (p === '/api/ask' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      return sendJson(res, await api.askAll(String(b.q || '')));
    }
    if (p === '/api/school') return sendJson(res, await api.schoolInfo(u.searchParams.get('dir')));
  } catch (e) {
    return send(res, 500, 'ошибка: ' + String((e && e.message) || e));
  }
  return send(res, 404, 'нет такой страницы');
}

// ─────────── старт/стоп ───────────
function start(opts) {
  api = opts.api;
  termInfo = opts.termInfo;
  if (srv) return status();
  token = crypto.randomBytes(16).toString('hex');
  port = Number(opts.port) || 8790;
  srv = http.createServer((req, res) => {
    handle(req, res).catch(() => { try { send(res, 500, 'ошибка'); } catch (_) {} });
  });
  srv.on('upgrade', (req, socket, head) => {
    if (!hostAllowed(req) || !authed(req)) return socket.destroy();
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/term/')) proxyWs(req, socket, head, u.pathname.replace(/^\/term/, '') + (u.search || ''));
    else socket.destroy();
  });
  srv.on('error', () => { srv = null; });
  srv.listen(port, '0.0.0.0');   // локальная сеть/VPN; наружу в интернет НЕ выставляем
  return status();
}
function stop() {
  if (srv) { try { srv.close(); } catch (_) {} srv = null; token = ''; }
  return { on: false };
}
function status() {
  if (!srv) return { on: false };
  const addrs = lanAddresses();
  const host = addrs.length ? addrs[0].address : '127.0.0.1';
  return { on: true, port, token, url: `http://${host}:${port}/?t=${token}`, addresses: addrs };
}

module.exports = { start, stop, status };
