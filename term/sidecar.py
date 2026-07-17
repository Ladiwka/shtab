"""
ШТАБ · кокпит — локальный терминал-сайдкар.

Держит настоящий `claude` в ConPTY (pywinpty) для каждой папки-проекта и отдаёт его
в окно приложения через xterm.js по локальному WebSocket. Только 127.0.0.1, без
интернета/туннеля/телеги. Защита:
  • токен запуска (SHTAB_TOKEN) обязателен на / и /ws — чужая страница в браузере не знает его;
  • cwd разрешён только внутри известных корней проектов (SHTAB_ROOTS);
  • xterm.js отдаётся локально из ./vendor (в webview CDN заблокирован).

Конфиг — через окружение:
  SHTAB_PORT   — порт (127.0.0.1)
  SHTAB_TOKEN  — случайный токен запуска
  SHTAB_CLAUDE — путь к claude.exe
  SHTAB_ROOTS  — корни проектов через ';' (cwd обязан быть внутри одного из них)
"""
import asyncio
import json
import logging
import os
import re
import signal
import sys
import threading
import time
from pathlib import Path

from aiohttp import web, WSMsgType

# PTY: винда — pywinpty (ConPTY), мак/линукс — ptyprocess. API совпадает
# (spawn/read/write/setwinsize/terminate/isalive), поэтому остальной код общий.
if sys.platform == "win32":
    from winpty import PtyProcess
else:
    from ptyprocess import PtyProcessUnicode

    class PtyProcess(PtyProcessUnicode):
        # рваный UTF-8 на границе чтения не должен ронять reader-поток
        def __init__(self, pid, fd, encoding="utf-8", codec_errors="replace"):
            super().__init__(pid, fd, encoding, codec_errors)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("shtab.term")

PORT = int(os.environ.get("SHTAB_PORT", "8760"))
TOKEN = os.environ.get("SHTAB_TOKEN", "")
CLAUDE = os.environ.get("SHTAB_CLAUDE", "claude")
# другие помощники в терминале (по выбору в окне): имя → команда. Пути приходят из main.js,
# который ищет их в PATH; чего нет на машине — в списке не появится.
AGENTS = {}
for _pair in os.environ.get("SHTAB_AGENTS", "").split(";"):
    if "=" in _pair:
        _k, _v = _pair.split("=", 1)
        if _k.strip() and _v.strip():
            AGENTS[_k.strip()] = _v.strip()
ROOTS = [Path(p).resolve() for p in os.environ.get("SHTAB_ROOTS", "").split(";") if p.strip()]
HERE = Path(__file__).resolve().parent
MIN_ROWS, MIN_COLS = 8, 20


# --------------------------------------------------------------- безопасность
def _token_ok(request: web.Request) -> bool:
    return bool(TOKEN) and request.query.get("token", "") == TOKEN


def _cwd_allowed(cwd: str) -> Path | None:
    try:
        p = Path(cwd).resolve()
    except Exception:
        return None
    if not p.is_dir():
        return None
    for root in ROOTS:
        if p == root or root in p.parents:
            return p
    return None


# --------------------------------------------------------------- claude spawn
def _claude_has_session(cwd: str) -> bool:
    try:
        enc = re.sub(r"[^A-Za-z0-9]", "-", str(Path(cwd).resolve()))
        d = Path.home() / ".claude" / "projects" / enc
        return d.is_dir() and any(d.glob("*.jsonl"))
    except Exception:
        return False


def _clean_env() -> dict:
    e = dict(os.environ)
    for k in ("CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
              "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_EXECPATH", "AI_AGENT", "CLAUDE_EFFORT",
              "SHTAB_TOKEN", "SHTAB_AGENTS", "SHTAB_CLAUDE", "SHTAB_ROOTS", "SHTAB_PORT"):
        e.pop(k, None)
    e["TERM"] = "xterm-256color"
    return e


def _spawn_claude(cwd: str, rows: int, cols: int, fresh: bool = False, agent: str = "") -> PtyProcess:
    """agent='' → claude (по умолчанию). Иначе — другой помощник из SHTAB_AGENTS (codex/gemini…)."""
    if agent and agent in AGENTS:
        cmd = [AGENTS[agent]]
    else:
        cmd = [CLAUDE]
        if not fresh and _claude_has_session(cwd):
            cmd.append("--continue")   # «продолжить прошлый диалог» есть только у claude
    return PtyProcess.spawn(cmd, dimensions=(rows, cols), cwd=cwd, env=_clean_env())


# --------------------------------------------------------------- сессии
class TermSession:
    def __init__(self, cwd: str, loop, fresh: bool = False, agent: str = ""):
        self.cwd = cwd
        self.agent = agent
        self.key = _skey(cwd, agent)
        self.loop = loop
        self.clients: dict[asyncio.Queue, tuple[int, int]] = {}
        self.size = (30, 90)
        self.continued = (not fresh) and (not agent) and _claude_has_session(cwd)
        self.spawn_t = time.time()
        self.last_out = time.time()  # когда сессия последний раз что-то печатала → «тихо N мин»
        self.had_client = False      # прогретую, но так и не открытую сессию потом погасим
        self.proc = _spawn_claude(cwd, *self.size, fresh=fresh, agent=agent)
        self.dead = False
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                data = self.proc.read(8192)
            except Exception:
                # процесс умер. Если это был `--continue`, упавший сразу («No conversation
                # found to continue» при битых/пустых сессиях) — сами стартуем начисто.
                # самолечение только если мы ещё «действующая» сессия своего ключа
                if (self.continued and not self.dead and time.time() - self.spawn_t < 8
                        and _sessions.get(self.key) is self):
                    self.continued = False
                    self.spawn_t = time.time()
                    try:
                        self.proc = _spawn_claude(self.cwd, *self.size, fresh=True, agent=self.agent)
                        self.loop.call_soon_threadsafe(
                            self._broadcast, "\r\n[прошлый диалог не открылся — начинаю новый]\r\n")
                        continue
                    except Exception:
                        pass
                break
            if data:
                s = data if isinstance(data, str) else data.decode("utf-8", "replace")
                self.last_out = time.time()
                self.loop.call_soon_threadsafe(self._broadcast, s)
            else:
                time.sleep(0.02)
        self.loop.call_soon_threadsafe(self._broadcast, None)

    def _broadcast(self, s):
        if s is None:
            self.dead = True
            # ВАЖНО: вычёркиваем только СЕБЯ. Раньше pop был безусловный: «🆕 новый» гасил
            # старую сессию, под тем же ключом уже жила новая — и reader умирающей выкидывал
            # из реестра ЖИВУЮ замену. Дальше любой reload поднимал ВТОРОЙ claude в той же папке.
            if _sessions.get(self.key) is self:
                _sessions.pop(self.key, None)
        for q in list(self.clients):
            try:
                q.put_nowait(s)
            except Exception:
                pass

    def _apply_size(self):
        if not self.clients:
            return
        r = max(MIN_ROWS, min(v[0] for v in self.clients.values()))
        c = max(MIN_COLS, min(v[1] for v in self.clients.values()))
        if (r, c) != self.size:
            self.size = (r, c)
            try:
                self.proc.setwinsize(r, c)
            except Exception:
                pass

    def add_client(self, q, rows, cols):
        self.clients[q] = (rows, cols)
        self.had_client = True
        self._apply_size()

    def remove_client(self, q):
        self.clients.pop(q, None)
        self._apply_size()

    def set_client_size(self, q, rows, cols):
        if q in self.clients:
            self.clients[q] = (rows, cols)
            self._apply_size()

    async def repaint(self):
        r, c = self.size
        try:
            self.proc.setwinsize(r, max(2, c - 1))
            await asyncio.sleep(0.12)
            self.proc.setwinsize(r, c)
        except Exception:
            pass

    def write(self, data: str):
        try:
            self.proc.write(data)
        except Exception:
            pass

    def stop(self):
        self.dead = True
        try:
            self.proc.terminate(force=True)
        except Exception:
            pass


_sessions: dict[str, TermSession] = {}


def _skey(cwd, agent=""):
    return str(Path(cwd).resolve()) + ("|" + agent if agent else "")


def _get_session(cwd: str, loop, fresh: bool = False, agent: str = "") -> TermSession:
    key = _skey(cwd, agent)
    sess = _sessions.get(key)
    if fresh and sess is not None:
        sess.stop()
        _sessions.pop(key, None)
        sess = None
    if sess is not None and (sess.dead or not sess.proc.isalive()):
        sess.stop()          # добить PTY отжившей сессии, а не бросать её висеть
        _sessions.pop(key, None)
        sess = None
    if sess is None:
        sess = TermSession(cwd, loop, fresh=fresh, agent=agent)
        _sessions[key] = sess
        log.info("новая сессия %s%s", key, " (fresh)" if fresh else "")
    return sess


# --------------------------------------------------------------- HTTP / WS
async def handle_index(request: web.Request) -> web.Response:
    if not _token_ok(request):
        return web.Response(status=403, text="forbidden")
    return web.Response(text=_HTML, content_type="text/html")


async def handle_sessions(request: web.Request) -> web.Response:
    """Кто сейчас работает, а кто молчит. НАМЕРЕННО отдаём только факт «молчит N секунд»:
    по молчанию «ждёт твоего ответа» и «закончил» неразличимы — врать не будем, пусть окно
    покажет честное «тихо N мин», а человек решит сам."""
    if not _token_ok(request):
        return web.Response(status=403, text="forbidden")
    now = time.time()
    out = []
    for key, s in list(_sessions.items()):
        try:
            out.append({
                "cwd": s.cwd, "agent": s.agent or "claude",
                "quiet": int(now - s.last_out),
                "alive": (not s.dead) and bool(s.proc.isalive()),
                "clients": len(s.clients),
            })
        except Exception:
            pass
    return web.json_response(out)


async def handle_warm(request: web.Request) -> web.Response:
    """Предпрогрев: поднять claude-сессию заранее (навёл мышь на вкладку «Терминал»),
    чтобы к клику TUI уже был готов. Тот же токен и белый список, что у /ws."""
    if not _token_ok(request):
        return web.Response(status=403, text="forbidden")
    p = _cwd_allowed(request.query.get("cwd", ""))
    if p is None:
        return web.Response(status=400, text="bad cwd")
    key = str(p)
    if key not in _sessions:
        try:
            _get_session(str(p), asyncio.get_running_loop())
            log.info("прогрев %s", key)
        except Exception as e:
            return web.Response(status=500, text=str(e))
    return web.Response(status=204)


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    loop = asyncio.get_running_loop()

    if not _token_ok(request):
        await ws.send_json({"type": "fatal", "msg": "Доступ запрещён (нет токена)."})
        await ws.close()
        return ws

    p = _cwd_allowed(request.query.get("cwd", ""))
    if p is None:
        await ws.send_json({"type": "fatal", "msg": "Папка вне разрешённых проектов."})
        await ws.close()
        return ws
    cwd = str(p)
    fresh = request.query.get("fresh") in ("1", "true", "yes")
    agent = request.query.get("agent", "")
    if agent and agent not in AGENTS:
        agent = ""
    try:
        rows = max(MIN_ROWS, min(80, int(request.query.get("rows", "30"))))
        cols = max(MIN_COLS, min(300, int(request.query.get("cols", "90"))))
    except ValueError:
        rows, cols = 30, 90

    try:
        sess = _get_session(cwd, loop, fresh=fresh, agent=agent)
    except Exception as e:
        await ws.send_json({"type": "fatal", "msg": f"Не удалось запустить помощника: {e}"})
        await ws.close()
        return ws

    q: asyncio.Queue = asyncio.Queue()
    sess.add_client(q, rows, cols)
    await ws.send_json({"type": "ready", "cwd": cwd, "agent": agent or "claude"})
    asyncio.create_task(sess.repaint())

    async def pump_out():
        while True:
            data = await q.get()
            if data is None:
                break
            try:
                await ws.send_str(data)
            except Exception:
                break
        if not ws.closed:
            await ws.close()

    out_task = asyncio.create_task(pump_out())
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    obj = json.loads(msg.data)
                except Exception:
                    continue
                if obj.get("t") == "in":
                    sess.write(obj.get("d", ""))
                elif obj.get("t") == "resize":
                    sess.set_client_size(q, int(obj["rows"]), int(obj["cols"]))
                    asyncio.create_task(sess.repaint())
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
    finally:
        sess.remove_client(q)
        out_task.cancel()
    return ws


def _shutdown():
    # Гасим все claude-сессии сами и выходим сразу (kill группы/дерева ненадёжен:
    # на POSIX claude — лидер своей сессии в pty, на винде venv-лаунчер сиротит интерпретатор).
    for s in list(_sessions.values()):
        try:
            s.stop()
        except Exception:
            pass
    os._exit(0)


def _watch_parent():
    # СТОРОЖ РОДИТЕЛЯ: Electron держит наш stdin-пайп; умер родитель (как угодно —
    # taskkill, краш, Cmd+Q) → stdin даёт EOF → гасим сессии и выходим. Это главная
    # защита от сирот на порту (taskkill /T дерево venv-лаунчера добивал нестабильно).
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    _shutdown()


async def _reap_warmed():
    """Прогрев (/warm по наведению мыши) поднимает claude заранее. Если вкладку так и не
    открыли — через 10 минут гасим: незачем держать процесс, который никто не смотрит."""
    while True:
        await asyncio.sleep(120)
        now = time.time()
        for key, s in list(_sessions.items()):
            if (not s.had_client) and (not s.clients) and now - s.spawn_t > 600:
                log.info("гашу прогретую, но неоткрытую сессию %s", key)
                s.stop()
                if _sessions.get(key) is s:
                    _sessions.pop(key, None)


async def start():
    app = web.Application()
    app.router.add_get("/", handle_index)
    app.router.add_get("/warm", handle_warm)
    app.router.add_get("/sessions", handle_sessions)
    app.router.add_get("/ws", handle_ws)
    asyncio.create_task(_reap_warmed())
    app.router.add_static("/vendor/", str(HERE / "vendor"))
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", PORT).start()
    if sys.platform != "win32":
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, _shutdown)
    log.info("терминал-сайдкар на 127.0.0.1:%s | claude=%s | корней=%d", PORT, CLAUDE, len(ROOTS))
    while True:
        await asyncio.sleep(3600)


# --------------------------------------------------------------- HTML (десктоп)
_HTML = r"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<link rel="stylesheet" href="/vendor/xterm.css"/>
<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>
<script src="/vendor/addon-webgl.js"></script>
<script src="/vendor/addon-canvas.js"></script>
<script src="/vendor/addon-web-links.js"></script>
<style>
  :root{
    --bg:#0c120e; --bar:rgba(18,24,20,.9); --line:rgba(255,255,255,.10); --ink:#e6efe6; --ink3:#8fa090;
    --accent:#8fc0a0;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);overflow:hidden;
            font-family:'Segoe UI',-apple-system,system-ui,sans-serif}
  #bar{position:absolute;top:0;left:0;right:0;height:38px;display:flex;align-items:center;
       gap:10px;padding:0 12px;color:var(--ink3);font-size:12.5px;
       background:var(--bar);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);z-index:5}
  #dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:0 0 auto;box-shadow:0 0 8px var(--accent)}
  #status{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
          font-family:'Cascadia Code','SF Mono',Menlo,Consolas,monospace;letter-spacing:.02em}
  .b{flex:0 0 auto;background:rgba(255,255,255,.06);color:var(--ink);border:1px solid var(--line);
     border-radius:9px;min-width:32px;height:28px;font-size:13px;line-height:1;cursor:pointer;
     display:inline-flex;align-items:center;justify-content:center;padding:0 10px;transition:all .15s}
  .b:hover{background:rgba(255,255,255,.14);border-color:var(--accent)}
  #term{position:absolute;top:38px;left:0;right:0;bottom:0;padding:12px 10px 8px}
  #boot{position:absolute;top:38px;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;
        gap:11px;color:var(--ink3);font-family:'Cascadia Code','SF Mono',Menlo,Consolas,monospace;font-size:14px;
        background:var(--bg);z-index:4;transition:opacity .45s}
  #boot.hide{opacity:0;pointer-events:none}
  #boot .spin{width:15px;height:15px;border-radius:50%;border:2px solid rgba(143,192,160,.22);
        border-top-color:var(--accent);animation:sp .8s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  #toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%) translateY(6px);z-index:6;
        padding:6px 14px;border-radius:14px;font-size:12px;color:var(--ink);
        background:rgba(18,26,20,.92);border:1px solid var(--line);opacity:0;pointer-events:none;
        transition:opacity .2s,transform .2s}
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div id="bar">
  <span id="dot"></span><span id="status">подключение…</span>
  <button class="b" id="fresh" title="Новый диалог (свежий claude)">🆕 новый</button>
  <button class="b" id="up" title="История вверх">▲</button>
  <button class="b" id="down" title="Вниз">▼</button>
  <button class="b" id="bottom" title="В конец">⤓</button>
</div>
<div id="term"></div>
<div id="boot"><span class="spin"></span>поднимаю Claude…</div>
<div id="toast"></div>
<script>
const bootEl=document.getElementById('boot'); let _booted=false;
function hideBoot(){ if(_booted) return; _booted=true; bootEl.classList.add('hide'); }
setTimeout(hideBoot, 15000); // страховка
const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token')||'';
const CWD = qs.get('cwd')||'';
const AGENT = qs.get('agent')||'';   // выбранный помощник (пусто = claude) — ДОЛЖЕН уехать на сервер
const SAY = qs.get('say')||'';   // авто-фраза claude при старте (кнопка «Играть» школы и т.п.)
let _saidOnce = false, _sayT = null, _promptSeen = false, _sayFallbackT = null;
function _sendSay(){ if(_saidOnce) return; _saidOnce = true;
  wsSend(SAY); setTimeout(()=>wsSend('\r'), 300); }
const statusEl=document.getElementById('status'), dotEl=document.getElementById('dot');
function setStatus(t,c){ statusEl.textContent=t; if(c) dotEl.style.background=c; }

const IS_MAC = /Mac/.test(navigator.platform);
const FONT_DEF = 13.5;
let _font = parseFloat(localStorage.getItem('shtabTermFont')||'') || FONT_DEF;
const term = new Terminal({
  fontFamily:"'Cascadia Code','SF Mono',Menlo,Consolas,monospace", fontSize:_font, cursorBlink:true,
  scrollback:8000,
  macOptionIsMeta:IS_MAC,   // Option = Meta: Option+Enter перенос строки в claude, Option+стрелки по словам
  theme:{background:'#0c120e',foreground:'#e6efe6',cursor:'#8fc0a0',
         selectionBackground:'#2a3a2e'}
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit); term.open(document.getElementById('term')); fit.fit();
(function(){
  try{ if(window.WebglAddon){ const gl=new WebglAddon.WebglAddon();
    gl.onContextLoss(()=>{try{gl.dispose();}catch(e){}}); term.loadAddon(gl); return; } }catch(e){}
  try{ if(window.CanvasAddon) term.loadAddon(new CanvasAddon.CanvasAddon()); }catch(e){}
})();
// кликабельные ссылки (claude часто печатает URL) — открываем НОВЫМ окном,
// main.js перехватит window.open со страниц 127.0.0.1 и отдаст системному браузеру
try{ if(window.WebLinksAddon) term.loadAddon(new WebLinksAddon.WebLinksAddon((e,uri)=>window.open(uri))); }catch(e){}

let ws=null, reconnTimer=null, reconnTry=0;
function wsUrl(fresh){
  let u = `ws://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`
        + `&cwd=${encodeURIComponent(CWD)}&cols=${term.cols}&rows=${term.rows}`;
  if(AGENT) u += `&agent=${encodeURIComponent(AGENT)}`;
  if(fresh) u += `&fresh=1`;
  return u;
}
function connect(fresh){
  clearTimeout(reconnTimer);
  if(ws){ try{ ws.onclose=null; ws.close(); }catch(e){} }
  ws = new WebSocket(wsUrl(fresh));
  ws.onopen = ()=>{ reconnTry=0; setStatus('подключено','#a4b47f'); };
  ws.onclose = ()=>{
    // эскалирующий backoff с потолком: если claude мёртв, не долбим сервер вечно каждые 1.5с
    reconnTry++;
    if(reconnTry > 8){ setStatus('нет связи — нажми «🆕 новый» или обнови','#c47a68'); return; }
    const wait = Math.min(1000 * reconnTry, 8000);
    setStatus('переподключение… ('+reconnTry+')','#d6a066');
    reconnTimer=setTimeout(()=>connect(false), wait);
  };
  ws.onerror = ()=> setStatus('ошибка связи','#c47a68');
  ws.onmessage = (ev)=>{
    let s = ev.data;
    if(typeof s==='string' && s.length && s[0]==='{'){
      try{ const o=JSON.parse(s);
        if(o.type==='ready'){ const n=(o.cwd||'').split(/[\\/]/).pop();
          setStatus((o.agent||'claude')+' · '+(n||''),'#a4b47f'); term.reset(); return; }
        if(o.type==='fatal'){ setStatus(o.msg,'#c47a68'); term.writeln('\r\n['+o.msg+']'); hideBoot(); return; }
      }catch(e){}
    }
    hideBoot();   // пришёл первый вывод claude — прячем шиммер
    term.write(s);
    if(s.indexOf('[?10')!==-1) setTimeout(disableMouse, 50);   // claude заново включил мышь → гасим
    // авто-фраза: шлём только когда claude РЕАЛЬНО готов — в выводе появилось приглашение «❯»
    // (тишина-детектор терял фразу: claude молчит и во время загрузки). Страховка: 30с и шлём как есть.
    if(SAY && !_saidOnce){
      if(!_promptSeen && s.indexOf('❯')!==-1) _promptSeen=true;
      if(!_sayFallbackT) _sayFallbackT=setTimeout(_sendSay, 30000);
      if(_promptSeen){ clearTimeout(_sayT); _sayT=setTimeout(_sendSay, 900); }
    }
  };
}
function wsSend(d){ if(ws && ws.readyState===1) ws.send(JSON.stringify({t:'in',d})); }
connect(false);
term.onData(d=> wsSend(d));

// ВЫДЕЛЕНИЕ ДОЛЖНО РАБОТАТЬ ВСЕГДА: claude включает mouse-tracking, и xterm отдаёт мышь
// приложению вместо выделения. Гасим tracking ЛОКАЛЬНО (только в xterm) — claude не в курсе,
// наш синтетический SGR-скролл (wheel1) ходит мимо xterm и продолжает работать.
function disableMouse(){ try{ term.write('\x1b[?1003l\x1b[?1002l\x1b[?1000l'); }catch(e){} }
setInterval(disableMouse, 4000);
setTimeout(disableMouse, 800);

function sendResize(){ fit.fit();
  if(ws && ws.readyState===1) ws.send(JSON.stringify({t:'resize',cols:term.cols,rows:term.rows})); }
window.addEventListener('resize', ()=>setTimeout(sendResize,80));
setTimeout(sendResize,300);

// прокрутка истории claude — шлём SGR-щелчки колеса в СЕРЕДИНУ экрана (всегда в пределах сетки),
// ровным темпом. БЕЗ блокировки на «claude активен» — раньше при работающем claude скролл замирал.
function wheel1(dir){ const b=dir>0?65:64;
  const c=Math.max(1,Math.floor((term.cols||80)/2)), r=Math.max(1,Math.floor((term.rows||24)/2));
  wsSend(`\x1b[<${b};${c};${r}M`); }
let _q=0,_pump=null;
function pump(){ if(_pump) return;
  _pump=setInterval(()=>{ if(_q===0){clearInterval(_pump);_pump=null;return;}
    const d=_q>0?1:-1; _q-=d; wheel1(d); },45); }
function scrollBy(n){ _q=Math.max(-18,Math.min(18,_q+n)); pump(); }
document.getElementById('up').onclick=()=>scrollBy(-3);
document.getElementById('down').onclick=()=>scrollBy(3);
document.getElementById('bottom').onclick=()=>scrollBy(12);
// колесо/тачпад: аккумулируем пиксели до порога — мак-тачпад стреляет десятками мелких
// событий с инерцией, «щелчок за событие» крутил бы бешено; колесо мыши (±100px) = 2 тика как раньше.
// CAPTURE + stopPropagation ОБЯЗАТЕЛЬНЫ: без mouse-mode xterm сам превращает колесо в СТРЕЛКИ
// (alt-буфер) → у claude листалась история промптов; глушим его обработчик, шлём только наш SGR.
let _acc=0;
document.getElementById('term').addEventListener('wheel',e=>{
  e.preventDefault(); e.stopPropagation(); try{term.focus();}catch(_){}
  const px = e.deltaMode===1 ? e.deltaY*16 : e.deltaMode===2 ? e.deltaY*300 : e.deltaY;
  _acc += px;
  const TH=40, n=Math.trunc(_acc/TH);
  if(n){ _acc-=n*TH; scrollBy(n); }
}, {passive:false, capture:true});
document.getElementById('fresh').onclick=()=>{ reconnTry=0; term.reset(); setStatus('новый диалог…','#d6a066'); connect(true); };

// копипаст. Правила: выделил мышью = УЖЕ скопировано (+тост); Ctrl+C/Cmd+C при живом выделении =
// копия (без выделения Ctrl+C = прерывание claude, как и должно); вставка — Cmd+V (мак),
// Ctrl+Shift+V (винда), правый клик. Голый Ctrl+V НЕ трогаем — им claude вставляет картинки.
// Клавиши сравниваем по e.code (физическая клавиша) — работает и на русской раскладке.
const toastEl=document.getElementById('toast'); let _toastT=null;
function toast(t){ toastEl.textContent=t; toastEl.classList.add('show');
  clearTimeout(_toastT); _toastT=setTimeout(()=>toastEl.classList.remove('show'),900); }
function copySel(){
  if(!term.hasSelection()) return false;
  navigator.clipboard.writeText(term.getSelection()).catch(()=>{});
  toast('скопировано'); return true;
}
function pasteClip(){ navigator.clipboard.readText().then(t=>{ if(t) term.paste(t); }).catch(()=>{}); }
// выделил — уже в буфере (дебаунс: onSelectionChange стреляет на каждое движение мыши)
let _selT=null;
term.onSelectionChange(()=>{ clearTimeout(_selT); _selT=setTimeout(()=>{
  const s=term.getSelection(); if(s && s.trim()){ navigator.clipboard.writeText(s).catch(()=>{}); toast('скопировано'); }
},250); });

function setFont(px){
  px=Math.max(9,Math.min(26,px)); _font=px;
  term.options.fontSize=px;
  try{ localStorage.setItem('shtabTermFont',String(px)); }catch(_){}
  sendResize();
}
term.attachCustomKeyEventHandler(e=>{
  if(e.type!=='keydown') return true;
  const zmod = IS_MAC ? (e.metaKey && !e.altKey) : (e.ctrlKey && !e.altKey && !e.shiftKey);
  if(zmod && (e.key==='=' || e.key==='+')){ setFont(_font+1); return false; }
  if(zmod && e.key==='-'){ setFont(_font-1); return false; }
  if(zmod && e.key==='0'){ setFont(FONT_DEF); return false; }
  // Ctrl+C / Cmd+C с выделением = копировать (как Windows Terminal); без выделения — уйдёт claude
  const plainC = e.code==='KeyC' && !e.shiftKey && !e.altKey && (IS_MAC ? e.metaKey : e.ctrlKey);
  if(plainC && term.hasSelection()){ copySel(); term.clearSelection(); return false; }
  const cmod = IS_MAC ? (e.metaKey && !e.ctrlKey && !e.altKey) : (e.ctrlKey && e.shiftKey);
  if(!cmod) return true;
  if(e.code==='KeyC'){ copySel(); return false; }
  if(e.code==='KeyV'){ pasteClip(); return false; }
  return true;
});
// правый клик: есть выделение → скопировать, нет → вставить (как в Windows Terminal)
document.getElementById('term').addEventListener('contextmenu',e=>{
  e.preventDefault();
  if(copySel()) term.clearSelection(); else pasteClip();
});
setTimeout(()=>term.focus(),200);
</script>
</body>
</html>
"""


if __name__ == "__main__":
    threading.Thread(target=_watch_parent, daemon=True).start()
    try:
        asyncio.run(start())
    except KeyboardInterrupt:
        pass
