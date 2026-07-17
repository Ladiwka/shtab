// ШТАБ · кокпит — логика окна.
// Каждый проект: страница (журнал + файлы) → провалиться в файл/подпапку → открыть живой
// сайт встроенным окном. Ссылки внутри сайта остаются в окне. Навигация «назад» — общая.

const API = window['штаб'] || null;
const IS_APP = !!(API && API.isApp);

const els = {
  nav: document.getElementById('nav'),
  stage: document.getElementById('stage'),
  title: document.getElementById('title'),
  addrText: document.getElementById('addrText'),
  back: document.getElementById('backBtn'),
  fwd: document.getElementById('fwdBtn'),
  reload: document.getElementById('reloadBtn'),
  notes: document.getElementById('notes'),
  notesBtn: document.getElementById('notesBtn'),
  notesText: document.getElementById('notesText'),
  savedMark: document.getElementById('savedMark'),
  syncBtn: document.getElementById('syncBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
};

let projects = { work: [], base: [] };
let current = null;      // текущий проект
let stack = [];          // история видов внутри проекта: {kind,dir|path|url}
let webview = null;      // активный <webview>, если открыт живой сайт

// стена терминалов (несколько живых claude рядом) — раскладка и выбор помнятся между запусками
let gridLayout = 2;                       // сколько ячеек: 1/2/3/4
let gridSel = [null, null, null, null];   // выбранный проект в каждой ячейке
let gridTermInfo = null;
try {
  const g = JSON.parse(localStorage.getItem('shtab.grid') || 'null');
  if (g && g.layout >= 1 && g.layout <= 4) { gridLayout = g.layout; if (Array.isArray(g.sel)) gridSel = g.sel.slice(0, 4); }
} catch (_) {}
function saveGrid() { try { localStorage.setItem('shtab.grid', JSON.stringify({ layout: gridLayout, sel: gridSel })); } catch (_) {} }

const sleep = ms => new Promise(r => setTimeout(r, ms));
// разделы сайдбара приходят из main (базовые + свои из профиля) — в окне не хардкодим
let navGroups = [{ key: 'work', label: 'Проекты' }, { key: 'study', label: 'Учёба' }, { key: 'base', label: 'Общее' }];
const allProjects = () => navGroups.flatMap(g => projects[g.key] || []);

const esc = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─────────── обои проектов (лежат файлами в assets/wall — чёткие на любом экране) ───────────
const WALLS = ['aurora-forest', 'purple-night', 'ocean-sunset', 'aurora-snow', 'canyon-stars', 'nebula',
  'foggy-mountains', 'starfield', 'milkyway-peaks', 'purple-galaxy', 'milkyway-figure', 'forest-dusk', 'misty-forest'];
function hashStr(s) { let h = 0; s = s || ''; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
// обой проекта: заданный в профиле (p.wall) или стабильно по хешу имени
function autoWall(p) { return 'assets/wall/' + (p.wall && WALLS.includes(p.wall) ? p.wall : WALLS[hashStr(p.id || p.name) % WALLS.length]) + '.jpg'; }
let customWalls = {};   // {id: {rel, video}} — свои фоны владельца, из data/walls.json
// картинка для аватара/миниатюры: своё фото — его; своё видео — авто-картинку; иначе авто
function wallFor(p) { const c = customWalls[p.id]; return (c && c.rel && !c.video) ? c.rel : autoWall(p); }
function wallInfo(p) {
  const c = customWalls[p.id];
  if (c && c.rel) return { url: c.rel, video: !!c.video, custom: true };
  return { url: autoWall(p), video: false, custom: false };
}
const bgs = [document.getElementById('bgA'), document.getElementById('bgB')];
const bgv = document.getElementById('bgv');
let bgi = 0;
function setWall(p) {
  const info = wallInfo(p);
  if (info.video) {
    bgs.forEach(b => b.classList.remove('show'));
    if (bgv.getAttribute('src') !== info.url) bgv.src = info.url;
    bgv.classList.add('show'); try { bgv.play(); } catch (_) {}
  } else {
    bgv.classList.remove('show'); try { bgv.pause(); } catch (_) {}
    const nx = bgs[1 - bgi];
    nx.style.backgroundImage = `url('${info.url}')`;
    nx.classList.add('show'); bgs[bgi].classList.remove('show'); bgi = 1 - bgi;
  }
}

// ─────────── боковая колонка ───────────
function renderNav() {
  els.nav.innerHTML = '';
  // верхние пункты — обзорный дашборд и хвосты (пульт над всеми проектами)
  const top = document.createElement('div');
  top.className = 'nav-top';
  const mkTop = (id, icon, name, fn) => {
    const it = document.createElement('div');
    it.className = 'item'; it.dataset.id = id;
    it.innerHTML = `<span class="av icon">${icon}</span><span class="name">${name}</span>`;
    it.addEventListener('click', fn);
    return it;
  };
  top.appendChild(mkTop('__home__', '⌂', 'Обзор', openDashboard));
  const tl = mkTop('__tails__', '✓', 'Хвосты', openTails);
  tl.insertAdjacentHTML('beforeend', '<span class="abadge muted" id="tailBadge" style="display:none"></span>');
  top.appendChild(tl);
  const ag = mkTop('__agents__', '🤖', 'Агенты', openAgents);
  ag.insertAdjacentHTML('beforeend', '<span class="abadge" id="agentBadge" style="display:none"></span>');
  top.appendChild(ag);
  top.appendChild(mkTop('__search__', '🔍', 'Поиск', () => openSearch('')));
  top.appendChild(mkTop('__usage__', '◔', 'Расход', openUsage));
  els.nav.appendChild(top);
  void refreshAgentBadge();
  void refreshTailBadge();
  for (const g of navGroups) {
    const list = projects[g.key] || [];
    if (!list.length) continue;
    const gl = document.createElement('div');
    gl.className = 'nav-group';
    gl.textContent = g.label;
    els.nav.appendChild(gl);
    for (const p of list) {
      const item = document.createElement('div');
      item.className = 'item';
      item.dataset.id = p.id;
      item.innerHTML =
        `<span class="av" style="background-image:url('${wallFor(p)}')"></span>` +
        `<span class="name">${esc(p.name)}</span>` +
        `<span class="hd" style="background:${p.color}"></span>`;
      item.addEventListener('click', () => openProject(p));
      // навёл на проект в списке → claude в его папке начинает подниматься заранее (идемпотентно)
      item.addEventListener('mouseenter', () => prewarmTerm(p.path), { once: true });
      els.nav.appendChild(item);
    }
  }
  // рабочий стол — стена терминалов
  const gl = document.createElement('div');
  gl.className = 'nav-group'; gl.textContent = 'Рабочий стол';
  els.nav.appendChild(gl);
  const gi = document.createElement('div');
  gi.className = 'item'; gi.dataset.id = '__grid__';
  gi.innerHTML = `<span class="av icon">⌗</span><span class="name">Терминалы</span>`;
  gi.addEventListener('click', openTerminalGrid);
  els.nav.appendChild(gi);
}

function markActive(id) {
  document.querySelectorAll('.item').forEach(el =>
    el.classList.toggle('active', el.dataset.id === id));
}

// ─────────── обзорный дашборд (стартовый экран: все проекты плитками со статусом) ───────────
const HEALTH = { ok: { c: 'ok', t: 'идёт' }, slow: { c: 'slow', t: 'тихо' }, stuck: { c: 'stuck', t: 'затык' } };

async function openDashboard() {
  // ушёл из проекта на Обзор — тоже засчитываем просмотр (иначе твоя же работа вернётся «сдвинулось»)
  if (current && IS_APP && API.seenMark) { seenMap[current.id] = Date.now(); API.seenMark(current.id).catch(() => {}); }
  enterGlobal(openDashboard);
  markActive('__home__');
  setWall({ id: '__home__' });   // свой спокойный обой у обзора (стабильно по хешу)
  els.title.textContent = 'Обзор'; els.addrText.textContent = '';
  els.back.style.opacity = '.35';
  els.stage.innerHTML = `<div class="scroll"><div class="dash">
    <div id="dcontinue"></div>
    <div id="dschool"></div>
    <div class="dash-head"><div class="dash-h">Обзор проектов</div><div class="dsummary" id="dsummary"></div>
      <button class="dash-snap" id="dashDid" title="Что я сделал за вчера/неделю по всем проектам — вспомнить, на чём остановился">↺ что я сделал</button>
      <button class="dash-snap" id="dashSnap" title="Текстовый обзор всех проектов — вставить в заметку или сообщение">⧉ снимок</button></div>
    <div class="dgrid" id="dgrid"></div>
    <div id="dquiet"></div></div></div>`;
  document.getElementById('dashSnap')?.addEventListener('click', openDashSnapshot);
  document.getElementById('dashDid')?.addEventListener('click', () => openDid());
  renderContinueStrip();
  void renderSchoolStrip();
  const ps = allProjects();
  const grid = document.getElementById('dgrid');
  // первый запуск / папка не указана — не пустой экран, а понятное «с чего начать»
  if (!ps.length) {
    grid.innerHTML = `<div class="welcome">
      <div class="w-h">Здесь будут твои проекты</div>
      <p>ШТАБ показывает каждую папку с проектом: что там происходит простым языком,
         терминал с ИИ-помощником, файлы и живой сайт — всё в одном окне.</p>
      <p>Покажи папку, внутри которой лежат проекты (у каждого — своя подпапка).</p>
      <button class="foot-btn w-btn" data-a="pick">Указать папку с проектами</button>
      <div class="w-demo">Просто посмотреть, как оно выглядит?
        <span class="board-act" data-a="demo">▶ Открыть на демо-проектах</span></div>
    </div>`;
    grid.querySelector('[data-a="pick"]').addEventListener('click', async () => {
      if (!IS_APP) return;
      const roots = await API.settingsAddRoot().catch(() => null);
      if (roots && roots.length) { await reloadProjects(); openDashboard(); }
    });
    // демо: живой ШТАБ с готовыми выжимками — без питона, claude и своих проектов
    grid.querySelector('[data-a="demo"]')?.addEventListener('click', async () => {
      if (!IS_APP) return;
      const r = await API.demoOn().catch(() => null);
      if (r && r.ok) { await reloadProjects(); openDashboard(); }
      else grid.querySelector('.w-demo').textContent = (r && r.error) || 'не вышло';
    });
    return;
  }
  // «Со вчера»: подтянуть карту последних заходов; первый запуск — проставить «сейчас» всем (не вспыхивать)
  if (IS_APP && API.seenGet) {
    seenMap = await API.seenGet().catch(() => ({}));
    if (!Object.keys(seenMap).length) { await API.seenInit(ps.map(x => x.id)).catch(() => {}); seenMap = await API.seenGet().catch(() => ({})); }
    snoozeMap = await API.snoozeGet().catch(() => ({}));
  }
  grid.innerHTML = ps.map(p => `<div class="dtile" data-id="${esc(p.id)}" style="--pc:${p.color}">
      <div class="dthumb" style="background-image:url('${wallFor(p)}')"></div>
      <div class="dbody"><div class="dtop"><span class="dpill off" data-h>—</span><span class="dname">${esc(p.name)}</span>
        <span class="dseen" data-seen></span><span class="dspark" data-spark></span></div>
        <div class="dpulse" data-p>…</div></div></div>`).join('');
  grid.querySelectorAll('.dtile').forEach(el => el.addEventListener('click', () => {
    const p = allProjects().find(x => x.id === el.dataset.id); if (p) openProject(p);
  }));
  const fillTile = (p, st, pending) => {
    const tile = grid.querySelector(`.dtile[data-id="${CSS.escape(p.id)}"]`); if (!tile) return;
    const h = st ? (HEALTH[st.health] || HEALTH.slow) : { c: 'off', t: '—' };
    const pill = tile.querySelector('[data-h]'); pill.className = 'dpill ' + h.c; pill.textContent = h.t;
    tile.querySelector('[data-p]').textContent = st ? (st.pulse || '') : (pending ? '⟳ готовлю выжимку…' : 'нет выжимки');
  };
  const setSeen = (p, srcMtime) => {
    const tile = grid.querySelector(`.dtile[data-id="${CSS.escape(p.id)}"]`); if (!tile) return;
    const el = tile.querySelector('[data-seen]'); if (!el) return;
    el.className = 'dseen'; el.textContent = '';
    const b = seenBadge(p.id, srcMtime); if (b) { el.classList.add(b.cls); el.textContent = b.text; }
  };
  const metas = await Promise.all(ps.map(p => (IS_APP ? API.getStatus(p.id, p.path).catch(() => null) : null)));
  // журнал новее выжимки → карточки обновятся сами (очередь по 2). Для них показываем «готовлю…», не «нет»
  const stale = ps.filter((p, i) => metas[i] && (metas[i].stale || (!metas[i].data && metas[i].hasSource)));
  const staleIds = new Set(stale.map(p => p.id));
  ps.forEach((p, i) => { fillTile(p, metas[i] && metas[i].data, staleIds.has(p.id)); setSeen(p, metas[i] && metas[i].srcMtime); });
  await logAndDrawSparks(ps, metas, grid);
  renderQuiet(ps, metas);
  dashSnap = { ps, metas };   // для «⧉ снимок» — текстовый обзор всех проектов
  updateDashSummary(ps, metas);
  let qi = 0;
  const worker = async () => {
    while (qi < stale.length && grid.isConnected) {
      const p = stale[qi++];
      const tile = grid.querySelector(`.dtile[data-id="${CSS.escape(p.id)}"]`);
      const pulseEl = tile && tile.querySelector('[data-p]');
      if (pulseEl) pulseEl.textContent = '⟳ обновляю из журнала…';
      const r = await API.refreshStatus(p.id, p.path).catch(() => null);
      const fresh = await API.getStatus(p.id, p.path).catch(() => null);
      if (grid.isConnected) { fillTile(p, fresh && fresh.data); setSeen(p, fresh && fresh.srcMtime); metas[ps.indexOf(p)] = fresh; }
      // причину НЕ глотаем: главная фича не должна молча умирать на первом экране
      if (grid.isConnected && (!r || !r.ok) && !(fresh && fresh.data) && pulseEl) pulseEl.textContent = whyNoStatus(r);
    }
    if (grid.isConnected) { dashSnap = { ps, metas }; updateDashSummary(ps, metas); }   // после обновлений — свежая сводка
  };
  if (IS_APP && stale.length) { void worker(); void worker(); }
}

// Почему не получилось сделать выжимку — СЛОВАМИ. Раньше reason доезжал до окна и выбрасывался:
// человек видел «нет выжимки» и не знал, что чинить (а чинится одной командой).
const NO_STATUS = {
  'no-python': 'нет выжимки · питон не найден — запусти Поднять-на-Windows.cmd (на маке — Поднять-на-маке.command)',
  'shot': 'нет выжимки',
  'busy': '⟳ очередь занята — обновлю следом',
};
function whyNoStatus(r) {
  const why = r && r.reason;
  if (!why) return 'нет выжимки';
  if (NO_STATUS[why]) return NO_STATUS[why];
  if (/claude/i.test(why)) return 'нет выжимки · claude не запустился — проверь, что он стоит и залогинен';
  return 'нет выжимки · ' + String(why).slice(0, 90);
}

// «Ждут твоего слова»: пункты waiting размазаны по карточкам и режутся лимитом — а это ровно то,
// где стоит ТВОЁ решение, и без него проект не двигается. Собираем плоско, старшие — наверх.
// Такое возможно только при взгляде на все проекты сразу.
const WAIT_SHOW = 5;   // спокойный экран: лимит был только у групп, а этот раздел рос без предела
async function renderWaiting(order) {
  const box = document.getElementById('twait'); if (!box) return;
  const raw = [];
  for (const { p, m } of order) {
    for (const w of (m.data.waiting || [])) raw.push({ p, text: w, key: p.id + '|' + w });
  }
  if (!raw.length) { box.innerHTML = ''; return; }
  // возраст — от того, когда пункт ПОЯВИЛСЯ у нас (mtime проекта врал: правка README обнуляла возраст)
  const since = (IS_APP && API.waitingSince) ? await API.waitingSince(raw.map(r => ({ key: r.key }))).catch(() => ({})) : {};
  if (!box.isConnected) return;
  const now = Date.now();
  const rows = raw.map(r => ({ ...r, days: since[r.key] ? Math.floor((now - since[r.key]) / 86400000) : 0 }))
    .sort((a, b) => b.days - a.days);   // кто ждёт дольше — тот и наверху
  const item = (r) => `<div class="wait-row" data-id="${esc(r.p.id)}">
      <span class="quiet-dot" style="background:${r.p.color}"></span>
      <span class="wait-text">${esc(r.text)}</span>
      <span class="wait-proj">${esc(r.p.name)}</span>
      ${r.days >= 3 ? `<span class="wait-days">${r.days} дн</span>` : ''}</div>`;
  const rest = rows.slice(WAIT_SHOW);
  box.innerHTML = `<div class="wait-sec"><div class="wait-h">⏳ Ждут твоего слова · ${rows.length}</div>
    <div class="wait-hint">Без твоего решения эти проекты не двинутся. Сверху — те, что ждут дольше всех.</div>
    ${rows.slice(0, WAIT_SHOW).map(item).join('')}
    ${rest.length ? `<div class="tmore" data-a="wmore">показать ещё ${rest.length}</div>
      <div class="thidden" hidden>${rest.map(item).join('')}</div>` : ''}</div>`;
  box.querySelector('[data-a="wmore"]')?.addEventListener('click', (e) => {
    const h = e.target.nextElementSibling; if (h) h.hidden = false; e.target.remove();
  });
  box.querySelectorAll('.wait-row').forEach(row => row.addEventListener('click', () => {
    const p = allProjects().find(x => x.id === row.dataset.id); if (p) openProject(p);
  }));
}

// «Со вчера»: карта «когда последний раз открывал проект» (локально на машину) + бейдж на плитке.
// Проект шевельнулся ПОСЛЕ последнего захода → «● сдвинулось». Иначе — сколько дней тихо.
let seenMap = {};
let snoozeMap = {};
function seenBadge(id, srcMtime) {
  if (!srcMtime) return null;
  const seen = seenMap[id] || 0;
  if (srcMtime > seen + 2000) return { cls: 'moved', text: '● сдвинулось' };   // изменился с последнего захода
  // «отложил» — значит отложил везде: раздел 💤 его прячет, а плитка продолжала бубнить «тихо 40 дн»
  if (snoozeMap[id] && Date.now() < snoozeMap[id]) return null;
  const days = Math.floor((Date.now() - srcMtime) / 86400000);
  if (days >= 3) return { cls: 'quiet', text: `тихо ${days} дн` };               // давно молчит
  return null;                                                                    // недавно смотрел и тихо — без шума
}

// Пульс во времени: 7 точек здоровья за неделю на плитке — видно ТРЕНД, а не только «сейчас».
// Дни, когда замера не было (не открывал ШТАБ), — серые дыры, а не выдуманное «ok».
async function logAndDrawSparks(ps, metas, grid) {
  if (!IS_APP || !API.healthLog) return;
  const entries = ps.map((p, i) => {
    const st = metas[i] && metas[i].data;
    return st && st.health ? { id: p.id, health: st.health } : null;
  }).filter(Boolean);
  if (entries.length) await API.healthLog(entries).catch(() => {});
  const hist = await API.healthGet().catch(() => ({}));
  if (!grid.isConnected) return;
  const days = [];
  for (let k = 6; k >= 0; k--) {
    const d = new Date(Date.now() - k * 86400000);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const CLS = { ok: 'sp-ok', slow: 'sp-slow', stuck: 'sp-stuck' };
  ps.forEach((p) => {
    const tile = grid.querySelector(`.dtile[data-id="${CSS.escape(p.id)}"]`); if (!tile) return;
    const el = tile.querySelector('[data-spark]'); if (!el) return;
    const h = hist[p.id] || {};
    if (!Object.keys(h).length) { el.innerHTML = ''; return; }   // истории ещё нет — не рисуем пустоту
    el.innerHTML = days.map(d => `<i class="${h[d] ? (CLS[h[d]] || 'sp-slow') : 'sp-none'}"></i>`).join('');
    el.title = 'Здоровье за неделю (серое — в этот день ШТАБ не открывал)';
  });
}

// «Давно не заглядывал»: спокойный свёрнутый раздел внизу обзора — проекты, молчащие дольше 14 дней.
// Не тревога, а мягкое «не забыл?». «Отложить» прячет на 2 недели. Порог — 14 дней.
const QUIET_DAYS = 14;
function renderQuiet(ps, metas) {
  const box = document.getElementById('dquiet'); if (!box) return;
  const now = Date.now();
  const quiet = ps.map((p, i) => ({ p, src: metas[i] && metas[i].srcMtime }))
    .filter(({ p, src }) => src && (now - src) / 86400000 >= QUIET_DAYS && (!snoozeMap[p.id] || now > snoozeMap[p.id]))
    .map(({ p, src }) => ({ p, days: Math.floor((now - src) / 86400000) }))
    .sort((a, b) => b.days - a.days);
  if (!quiet.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<details class="quiet-sec"><summary>💤 Давно не заглядывал · ${quiet.length}</summary>
    <div class="quiet-hint">Молчат дольше двух недель. Не забыл про них? Открой — или отложи, спрошу позже.</div>
    ${quiet.map(({ p, days }) => `<div class="quiet-row" data-id="${esc(p.id)}">
      <span class="quiet-dot" style="background:${p.color}"></span>
      <span class="quiet-name">${esc(p.name)}</span><span class="quiet-days">тихо ${days} дн</span>
      <span class="board-act quiet-snooze" data-snooze="${esc(p.id)}">отложить</span></div>`).join('')}
  </details>`;
  box.querySelectorAll('.quiet-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-snooze]')) return;
      const p = allProjects().find(x => x.id === row.dataset.id); if (p) openProject(p);
    });
  });
  box.querySelectorAll('[data-snooze]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = el.dataset.snooze;
    snoozeMap[id] = Date.now() + 14 * 86400000;
    if (IS_APP) API.snoozeAdd(id).catch(() => {});
    el.closest('.quiet-row')?.remove();
    // если раздел опустел — убрать заголовок
    const rows = document.querySelectorAll('#dquiet .quiet-row');
    const sum = document.querySelector('#dquiet summary');
    if (sum) sum.textContent = `💤 Давно не заглядывал · ${rows.length}`;
    if (!rows.length) document.getElementById('dquiet').innerHTML = '';
  }));
}

// сводка «за 3 секунды» над сеткой: сколько идёт/тихо/затык + всё ли на сервере
async function updateDashSummary(ps, metas) {
  const box = document.getElementById('dsummary'); if (!box) return;
  let ok = 0, slow = 0, stuck = 0;
  for (const m of metas) {
    const st = m && m.data; if (!st) continue;
    if (st.health === 'ok') ok++; else if (st.health === 'stuck') stuck++; else slow++;
  }
  const parts = [];
  if (ok) parts.push(`<span class="ds-ok">${ok} идёт</span>`);
  if (slow) parts.push(`<span class="ds-slow">${slow} тихо</span>`);
  if (stuck) parts.push(`<span class="ds-stuck">${stuck} затык</span>`);
  let sync = '';
  try {
    const res = IS_APP ? await API.syncStatus() : null;
    if (res && res.rows) {
      const cl = res.rows.map(classifySync);
      const diverged = cl.filter(c => c.cls === 'bad').length;     // разошлось — самое опасное, вперёд всего
      const problems = cl.filter(c => c.cls === 'warn').length;
      sync = diverged ? `<span class="ds-stuck">⛔ разошлось: ${diverged}</span>`
        : problems ? `<span class="ds-slow">⚠ ${problems} не на сервере</span>`
        : `<span class="ds-ok">✓ всё на сервере</span>`;
    }
  } catch (_) {}
  if (!document.getElementById('dsummary')) return;
  box.innerHTML = parts.join('<span class="ds-dot">·</span>') + (sync ? `<span class="ds-dot">·</span>${sync}` : '');
}

// «Снимок штаба»: текстовый обзор всех проектов в Markdown — вставить в заметку/сообщение/документ.
// Данные уже в памяти (dashSnap), новых запросов нет.
let dashSnap = null;
function buildDashSnapshot() {
  const { ps, metas } = dashSnap || { ps: [], metas: [] };
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const groups = { ok: [], slow: [], stuck: [], off: [] };
  ps.forEach((p, i) => {
    const st = metas[i] && metas[i].data;
    const key = st ? (['ok', 'slow', 'stuck'].includes(st.health) ? st.health : 'slow') : 'off';
    groups[key].push({ p, st });
  });
  const L = [`# Штаб — снимок на ${date}`, ''];
  const counts = [];
  if (groups.ok.length) counts.push(`${groups.ok.length} идёт`);
  if (groups.slow.length) counts.push(`${groups.slow.length} тихо`);
  if (groups.stuck.length) counts.push(`${groups.stuck.length} затык`);
  if (counts.length) { L.push('**' + counts.join(' · ') + '**', ''); }
  const section = (title, arr) => {
    if (!arr.length) return;
    L.push(`## ${title}`, '');
    for (const { p, st } of arr) {
      L.push(`### ${p.name}`);
      if (st && st.pulse) L.push(st.pulse);
      const next = st && Array.isArray(st.next) ? st.next.filter(Boolean) : [];
      const waiting = st && Array.isArray(st.waiting) ? st.waiting.filter(Boolean) : [];
      if (next.length) { L.push('', '**Дальше:**'); next.forEach(x => L.push(`- ${x}`)); }
      if (waiting.length) { L.push('', '**Ждём:**'); waiting.forEach(x => L.push(`- ${x}`)); }
      if (st && st.updated) L.push('', `_обновлено ${st.updated}_`);
      L.push('');
    }
  };
  section('Идёт', groups.ok);
  section('Тихо', groups.slow);
  section('Затык', groups.stuck);
  section('Без выжимки', groups.off);
  return L.join('\n').trim() + '\n';
}
// красиво свёрстанный бриф всех проектов (тот же дистиллят, что «⧉ снимок», но не унылый .md, а экран)
function buildDashSnapshotHtml() {
  const { ps, metas } = dashSnap || { ps: [], metas: [] };
  if (!ps.length) return '<div class="msg">Пока нет проектов для обзора.</div>';
  const groups = { ok: [], slow: [], stuck: [], off: [] };
  ps.forEach((p, i) => {
    const st = metas[i] && metas[i].data;
    const key = st ? (['ok', 'slow', 'stuck'].includes(st.health) ? st.health : 'slow') : 'off';
    groups[key].push({ p, st });
  });
  const sec = (title, cls, arr) => {
    if (!arr.length) return '';
    const items = arr.map(({ p, st }) => {
      const next = st && Array.isArray(st.next) ? st.next.filter(Boolean) : [];
      const waiting = st && Array.isArray(st.waiting) ? st.waiting.filter(Boolean) : [];
      return `<div class="snap-proj"><div class="snap-pname" style="--pc:${p.color}">${esc(p.name)}</div>
        ${st && st.pulse ? `<div class="snap-pulse">${inline(st.pulse)}</div>` : ''}
        ${next.length ? `<div class="snap-sub">Дальше</div>${next.map(x => `<div class="sc-li">${inline(x)}</div>`).join('')}` : ''}
        ${waiting.length ? `<div class="snap-sub">Ждём</div>${waiting.map(x => `<div class="sc-li">${inline(x)}</div>`).join('')}` : ''}
        ${st && st.updated ? `<div class="snap-upd">обновлено ${esc(st.updated)}</div>` : ''}</div>`;
    }).join('');
    return `<div class="snap-sec"><div class="snap-sechead ${cls}">${title} · ${arr.length}</div>${items}</div>`;
  };
  return sec('Идёт', 'ds-ok', groups.ok) + sec('Тихо', 'ds-slow', groups.slow)
    + sec('Затык', 'ds-stuck', groups.stuck) + sec('Без выжимки', 'ds-off', groups.off);
}
function openDashSnapshot() {
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  showModal(`Снимок штаба · ${date}`, buildDashSnapshotHtml(),
    `<span class="board-act" data-a="snap-copy">⧉ скопировать как текст</span>`);
  document.querySelector('[data-a="snap-copy"]')?.addEventListener('click', async (e) => {
    const el = e.target; const md = buildDashSnapshot();
    try { if (IS_APP) await API.copyPath(md); else await navigator.clipboard.writeText(md);
      el.textContent = '✓ скопировано'; } catch (_) { el.textContent = '⚠ не вышло'; }
    setTimeout(() => { el.textContent = '⧉ скопировать как текст'; }, 1400);
  });
}
// лёгкий модальный оверлей (переиспользуемый): заголовок + контент + подвал; закрытие по ✕/фону/Escape
function showModal(title, bodyHtml, footHtml) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back'; back.id = 'modalBack';
  back.innerHTML = `<div class="modal"><div class="modal-head"><div class="modal-title">${esc(title)}</div>
      <span class="modal-x" data-a="modal-x">✕</span></div>
    <div class="modal-body">${bodyHtml}</div>
    ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}</div>`;
  document.body.appendChild(back);
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
  back.querySelector('[data-a="modal-x"]').addEventListener('click', closeModal);
}
function closeModal() { document.getElementById('modalBack')?.remove(); }

// свежесть статуса для проектов, открывающихся сразу в борд (Обзор не рендерится — раньше
// обновление не запускалось вовсе). Тихо в фоне; дубли гасит main (refreshingStatus).
async function ensureFreshStatus(p) {
  if (!IS_APP) return;
  const meta = await API.getStatus(p.id, p.path).catch(() => null);
  if (meta && (meta.stale || (!meta.data && meta.hasSource))) {
    void API.refreshStatus(p.id, p.path).catch(() => {});
  }
}

// «продолжить с того же места» — по кнопке (не авто), из localStorage
function renderContinueStrip() {
  const box = document.getElementById('dcontinue'); if (!box) return;
  let last = null;
  try { last = JSON.parse(localStorage.getItem('shtab.last') || 'null'); } catch (_) {}
  const p = last && allProjects().find(x => x.id === last.id);
  if (!p) { box.innerHTML = ''; return; }
  const tabName = { board: 'панель', overview: 'обзор', term: 'терминал', live: 'живьём' }[last.tab] || 'обзор';
  box.innerHTML = `<div class="dash-continue"><span class="dc-play">▶</span>
    Продолжить: <b>${esc(p.name)}</b> · ${esc(tabName)}</div>`;
  box.firstElementChild.addEventListener('click', () => {
    openProject(p);
    if (last.tab && projTabs.some(t => t.key === last.tab)) selectTab(last.tab);
  });
}

// школа: мягкое напоминание на дашборде (как Duolingo, но без давления)
async function renderSchoolStrip() {
  const box = document.getElementById('dschool'); if (!box || !IS_APP) return;
  const p = await API.schoolFind().catch(() => null);
  if (!p || !p.school || p.school.xp === null) { box.innerHTML = ''; return; }
  const d = p.school.daysSince;
  if (d === null || d < 1) { box.innerHTML = ''; return; }   // сегодня уже занимался — молчим
  const word = d === 1 ? 'вчера' : `${d} ${d < 5 ? 'дня' : 'дней'} назад`;
  box.innerHTML = `<div class="dash-continue school"><span class="dc-play">🎮</span>
    Питон-школа: занимался ${word} · <b>${p.school.xp} XP</b>${p.school.streak ? ` · стрик ${esc(p.school.streak)}` : ''}
    <span class="sch-cta">продолжить →</span></div>`;
  box.firstElementChild.addEventListener('click', () => {
    const proj = allProjects().find(x => x.id === p.id);
    if (proj) { openProject(proj); selectTab('board'); }
  });
}

// ─────────── хвосты: все «дальше»/«ждём» по проектам одним списком ───────────
async function openTails() {
  enterGlobal(openTails);
  markActive('__tails__');
  els.title.textContent = 'Хвосты'; els.addrText.textContent = '';
  els.back.style.opacity = '.35';
  els.stage.innerHTML = `<div class="scroll"><div class="tails">
    <div class="dash-h">Хвосты — что дальше по всем проектам</div>
    <div id="twait"></div>
    <div id="tlist" class="tlist"><div class="msg">Собираю…</div></div></div></div>`;
  const ps = allProjects();
  const metas = await Promise.all(ps.map(p => (IS_APP ? API.getStatus(p.id, p.path).catch(() => null) : null)));
  // ВАЖЕН ПОРЯДОК: пока не отсортировано, «показать ещё» = «я спрятал часть наугад».
  // Затыки — наверх, дальше свежие: сначала то, где ты реально застрял.
  const rank = (m) => { const h = m && m.data && m.data.health; return h === 'stuck' ? 0 : h === 'ok' ? 1 : 2; };
  const order = ps.map((p, i) => ({ p, m: metas[i] }))
    .filter(x => x.m && x.m.data && ((x.m.data.next || []).length || (x.m.data.waiting || []).length))
    .sort((a, b) => (rank(a.m) - rank(b.m)) || ((b.m.srcMtime || 0) - (a.m.srcMtime || 0)));
  const SHOW = 5;   // спокойный экран: видно 5, остальное — по кнопке (разворот не запоминается)
  let html = '';
  for (const { p, m } of order) {
    const st = m.data;
    const rows = [
      ...(st.next || []).map(x => ({ text: x, wait: false })),
      ...(st.waiting || []).map(x => ({ text: x, wait: true })),
    ];
    const item = (r) => `<div class="titem${r.wait ? ' wait' : ''}">${r.wait ? '⏳ ' : ''}${esc(r.text)}` +
      (r.wait ? '' : `<span class="titem-act" data-pid="${esc(p.id)}" data-task="${esc(r.text)}" title="Поручить это фоновому агенту — он сделает в отдельной ветке, покажет дифф">🤖 поручить</span>`) +
      `</div>`;
    const head = `<div class="tgname" data-id="${esc(p.id)}"><span class="tgdot" style="background:${p.color}"></span>${esc(p.name)}` +
      (rank(m) === 0 ? '<span class="tg-stuck">затык</span>' : '') + `</div>`;
    const shown = rows.slice(0, SHOW).map(item).join('');
    const rest = rows.slice(SHOW);
    html += `<div class="tgroup">${head}${shown}` +
      (rest.length ? `<div class="tmore" data-a="more">показать ещё ${rest.length}</div>
         <div class="thidden" hidden>${rest.map(item).join('')}</div>` : '') + `</div>`;
  }
  renderWaiting(order);
  const list = document.getElementById('tlist'); if (!list) return;
  list.innerHTML = html || `<div class="msg">Пока хвостов нет — везде чисто ✓</div>`;
  list.querySelectorAll('.tgname').forEach(el => el.addEventListener('click', () => {
    const p = allProjects().find(x => x.id === el.dataset.id); if (p) openProject(p);
  }));
  list.querySelectorAll('[data-a="more"]').forEach(el => el.addEventListener('click', () => {
    const box = el.nextElementSibling; if (box) box.hidden = false; el.remove();
  }));
  // мост «список задач → агенты»: у нас есть и то, и другое — не хватало одного клика между ними
  list.querySelectorAll('.titem-act').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const p = allProjects().find(x => x.id === el.dataset.pid); if (p) askAgentTask(p, el.dataset.task);
  }));
}

// ─────────── вкладки проекта (как в браузере: Панель/Обзор/Терминал/Живьём) ───────────
let projTabs = [], activeTab = null;
const paneEls = {}, paneReady = {};   // keep-alive: панели живут, прячутся display:none

function buildTabs(p) {
  const BOARDS = {
  };
  projTabs = [];
  if (BOARDS[p.id]) projTabs.push(BOARDS[p.id]);                                   // личный борд
  else if (p.school) projTabs.push({ key: 'board', label: 'Школа', icon: '🎮', kind: 'schoolboard' });  // игра-обучение
  else if (p.board) projTabs.push({ key: 'board', label: p.board.title, icon: p.board.icon, kind: 'jsonboard' });
  projTabs.push({ key: 'overview', label: 'Обзор', icon: '📋', kind: 'overview' });
  projTabs.push({ key: 'term', label: 'Терминал', icon: '❯', kind: 'term' });
  // несколько витрин (напр. два источника) → вкладка на каждую; иначе одна «Живьём»
  if (Array.isArray(p.lives) && p.lives.length) {
    p.lives.forEach((lv, i) => projTabs.push({ key: 'live' + i, label: lv.label || 'Витрина', icon: '▶', kind: 'web', url: lv.url }));
  } else if (p.live) {
    projTabs.push({ key: 'live', label: p.liveLabel || 'Живьём', icon: '▶', kind: 'web' });
  }
}

function openProject(p) {
  // уходя из проекта — отмечаем его просмотренным ЕЩЁ РАЗ: пока ты в нём работал, claude мог
  // дописать журнал, и без этого Обзор встречал бы «● сдвинулось» про твою же работу пять минут назад
  if (current && current.id !== p.id && IS_APP && API.seenMark) {
    seenMap[current.id] = Date.now(); API.seenMark(current.id).catch(() => {});
  }
  current = p;
  markActive(p.id);
  // «Со вчера»: открыл проект → отметить как просмотренный (точка «сдвинулось» гаснет)
  if (IS_APP && API.seenMark) { seenMap[p.id] = Date.now(); API.seenMark(p.id).catch(() => {}); }
  document.documentElement.style.setProperty('--pc', p.color || '#8fb1a8');
  setWall(p);
  els.title.textContent = p.name;
  buildTabs(p);
  for (const k in paneEls) delete paneEls[k];
  for (const k in paneReady) delete paneReady[k];
  stack = [{ kind: 'overview', dir: p.path }];   // drill-down внутри вкладки «Обзор»
  webview = null;
  const bar = projTabs.map(t => `<div class="ptab" data-k="${t.key}"><span class="ptab-i">${t.icon}</span>${esc(t.label)}</div>`).join('');
  els.stage.innerHTML = `<div class="projwrap"><div class="ptabs">${bar}</div><div class="ppanes" id="ppanes"></div></div>`;
  els.stage.querySelectorAll('.ptab').forEach(el => el.addEventListener('click', () => selectTab(el.dataset.k)));
  // предпрогрев: навёл мышь на «Терминал» → claude начинает подниматься ещё до клика
  const tt = els.stage.querySelector('.ptab[data-k="term"]');
  if (tt) tt.addEventListener('mouseenter', () => prewarmTerm(p.path), { once: true });
  // свежесть карточки не должна зависеть от того, какая вкладка первая (борд-проекты!)
  void ensureFreshStatus(p);
  selectTab(projTabs[0].key);
}

const _warmed = new Set();
async function prewarmTerm(dir) {
  if (!IS_APP || _warmed.has(dir)) return;
  _warmed.add(dir);
  try {
    const info = await API.termInfo();
    if (!info || !info.available) return;
    fetch(`http://127.0.0.1:${info.port}/warm?cwd=${encodeURIComponent(dir)}&token=${info.token}`,
      { mode: 'no-cors' }).catch(() => {});
  } catch (_) {}
}

function selectTab(key) {
  activeTab = key;
  if (current) { try { localStorage.setItem('shtab.last', JSON.stringify({ id: current.id, tab: key })); } catch (_) {} }
  const cont = document.getElementById('ppanes'); if (!cont) return;
  els.stage.querySelectorAll('.ptab').forEach(el => el.classList.toggle('on', el.dataset.k === key));
  Object.values(paneEls).forEach(el => { el.style.display = 'none'; });
  let pane = paneEls[key];
  if (!pane) { pane = document.createElement('div'); pane.className = 'ppane'; cont.appendChild(pane); paneEls[key] = pane; }
  pane.style.display = '';
  els.addrText.textContent = '';
  const t = projTabs.find(x => x.key === key);
  if (key === 'overview') { renderOverviewTab(pane); }                          // всегда из stack (drill-down)
  else { els.back.style.opacity = '.35'; if (!paneReady[key]) { paneReady[key] = true; renderTabKind(t, pane); } }
}

function renderTabKind(t, pane) {
  if (t.kind === 'jsonboard') return renderJsonBoard(pane);
  if (t.kind === 'schoolboard') return renderSchoolBoard(pane);
  if (t.kind === 'term') return openTerminalInto(pane);
  if (t.kind === 'web') return renderWeb(t.url || current.live, false, pane);   // t.url — своя витрина у вкладки
}

let pendingTermSay = '';   // авто-фраза для СЛЕДУЮЩЕГО открытия терминала (кнопка «Играть» школы)
const termAgent = {};      // выбранный помощник по проекту: '' = claude
async function openTerminalInto(pane) {
  if (!IS_APP) { pane.innerHTML = '<div class="msg">Терминал работает только в приложении.</div>'; return; }
  const info = await API.termInfo();
  if (!info || !info.available) { pane.innerHTML = '<div class="msg">Терминал недоступен: питон-рантайм не найден.<br>Мак: запусти «Поднять-на-маке.command». Винда: скажи Claude «почини терминал ШТАБа».</div>'; return; }
  const p = current;
  const others = info.agents || [];
  const cur = termAgent[p.id] || '';
  const say = pendingTermSay ? `&say=${encodeURIComponent(pendingTermSay)}` : '';
  pendingTermSay = '';
  const url = `http://127.0.0.1:${info.port}/?cwd=${encodeURIComponent(p.path)}&token=${info.token}` +
    (cur ? `&agent=${encodeURIComponent(cur)}` : '') + say;
  // на машине есть другие помощники → тонкая полоска выбора над терминалом
  if (others.length) {
    pane.innerHTML = `<div class="term-wrap"><div class="term-pick">
        <span class="tp-cap">помощник:</span>
        ${[{ key: '', name: 'Claude' }, ...others].map(a =>
          `<span class="tp${a.key === cur ? ' on' : ''}" data-k="${esc(a.key)}">${esc(a.name)}</span>`).join('')}
      </div><div class="term-host"></div></div>`;
    pane.querySelectorAll('.tp').forEach(el => el.addEventListener('click', () => {
      if ((termAgent[p.id] || '') === el.dataset.k) return;
      termAgent[p.id] = el.dataset.k;
      paneReady.term = false;
      if (paneEls.term) { paneEls.term.remove(); delete paneEls.term; }
      selectTab('term');
    }));
    renderWeb(url, true, pane.querySelector('.term-host'));
  } else {
    renderWeb(url, true, pane);
  }
}

// вкладка «Обзор» — страница проекта + drill-down по папкам/файлам (свой stack)
function renderOverviewTab(pane) {
  const v = stack[stack.length - 1];
  els.back.style.opacity = stack.length > 1 ? '1' : '.35';
  if (v.kind === 'file') { els.addrText.textContent = shortPath(v.path); renderFile(v.path, pane); }
  else { renderOverview(v.dir, pane); }
}

function pushView(v) {   // drill-down внутри «Обзора»
  stack.push(v);
  if (paneEls.overview) renderOverviewTab(paneEls.overview);
}

function back() {
  // во встроенном сайте/борде «назад» = назад по истории страницы (раньше работало только в «Обзоре»)
  const wv = paneEls[activeTab] && paneEls[activeTab].querySelector('webview');
  if (wv) { try { if (wv.canGoBack()) { wv.goBack(); return; } } catch (_) {} }
  if (activeTab === 'overview' && stack.length > 1) { stack.pop(); renderOverviewTab(paneEls.overview); }
  updateNavButtons();
}
function fwd() {
  const wv = paneEls[activeTab] && paneEls[activeTab].querySelector('webview');
  if (wv) { try { if (wv.canGoForward()) wv.goForward(); } catch (_) {} }
  updateNavButtons();
}
// стрелки в тулбаре светятся только когда реально работают
function updateNavButtons() {
  const wv = paneEls[activeTab] && paneEls[activeTab].querySelector('webview');
  let b = false, f = false;
  if (wv) { try { b = wv.canGoBack(); f = wv.canGoForward(); } catch (_) {} }
  else if (activeTab === 'overview') b = stack.length > 1;
  els.back.style.opacity = b ? '1' : '.35';
  els.fwd.style.opacity = f ? '1' : '.35';
}

async function openTerminal(dir) {
  if (!IS_APP) return;
  const info = await API.termInfo();
  if (!info || !info.available) {
    alert('Терминал недоступен: питон-рантайм не найден.\nМак: запусти «Поднять-на-маке.command». Винда: скажи Claude «почини терминал ШТАБа».');
    return;
  }
  // порт/токен известны сразу — показываем окно НЕМЕДЛЕННО (не ждём цикл готовности);
  // если сайдкар ещё встаёт, страница терминала сама переподключится (ретраи в renderWeb + WS).
  const url = `http://127.0.0.1:${info.port}/?cwd=${encodeURIComponent(dir)}&token=${info.token}`;
  pushView({ kind: 'term', url, label: 'терминал · ' + (current ? current.name : '') });
}

// ─────────── стена терминалов (4 живых claude рядом) ───────────
async function openTerminalGrid() {
  enterGlobal(openTerminalGrid);
  markActive('__grid__');
  els.title.textContent = 'Терминалы';
  els.addrText.textContent = '';
  els.back.style.opacity = '.35';
  // порт/токен известны сразу — не ждём цикл готовности; ячейки сами переподключатся
  gridTermInfo = await API.termInfo().catch(() => null);
  // первый заход — сразу расставить первые проекты по видимым ячейкам
  if (gridSel.every(x => !x)) {
    const ps = allProjects();
    for (let i = 0; i < gridLayout; i++) gridSel[i] = ps[i] ? ps[i].id : null;
    saveGrid();
  }
  renderGrid();
}

// проекты, уже занятые в ДРУГИХ видимых ячейках (чтобы не выбрать один и тот же дважды)
function optionsFor(i) {
  const taken = new Set(gridSel.filter((v, j) => v && j !== i && j < gridLayout));
  return `<option value="">— выбери проект —</option>` +
    allProjects()
      .filter(p => gridSel[i] === p.id || !taken.has(p.id))
      .map(p => `<option value="${esc(p.id)}"${gridSel[i] === p.id ? ' selected' : ''}>${esc(p.name)}</option>`)
      .join('');
}

// пересобрать варианты во всех выпадашках (занятый проект прячется, освобождённый — возвращается)
function refreshGridSelects() {
  els.stage.querySelectorAll('.gcell-sel').forEach((sel, i) => { sel.innerHTML = optionsFor(i); });
}

function renderGrid() {
  els.stage.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'grid-wrap';
  const tb = document.createElement('div');
  tb.className = 'grid-tb';
  tb.innerHTML = `<span class="grid-tb-h">⌗ Стена терминалов</span>
    <span class="grid-live" id="gridLive"></span>
    <span class="grid-layouts">${[1, 2, 3, 4].map(n =>
      `<button class="glbtn${n === gridLayout ? ' on' : ''}" data-n="${n}">${n}</button>`).join('')}</span>`;
  wrap.appendChild(tb);
  const g = document.createElement('div');
  g.className = `grid g-${gridLayout}`;
  for (let i = 0; i < gridLayout; i++) g.appendChild(buildCell(i));
  wrap.appendChild(g);
  els.stage.appendChild(wrap);
  tb.querySelectorAll('.glbtn').forEach(b =>
    b.addEventListener('click', () => { gridLayout = Number(b.dataset.n); saveGrid(); renderGrid(); }));
  startGridPulse(wrap);
}

// «кто работает, а кто молчит» — налог, который стена терминалов сама и создала: запустил агентов
// в пяти проектах и обходишь их глазами, ища замершего. ЧЕСТНО пишем «тихо N мин», а не «ждёт ответа»:
// по молчанию «спрашивает тебя» и «закончил» неразличимы — врать не будем.
let gridPulseTimer = null;
function startGridPulse(wrap) {
  clearInterval(gridPulseTimer);
  const tick = async () => {
    if (!wrap.isConnected) { clearInterval(gridPulseTimer); return; }
    const ss = (IS_APP && API.termSessions) ? await API.termSessions().catch(() => []) : [];
    if (!wrap.isConnected) return;
    const byCwd = new Map(ss.map(s => [String(s.cwd), s]));
    let work = 0; const quiet = [];
    for (let i = 0; i < gridLayout; i++) {
      const p = allProjects().find(x => x.id === gridSel[i]);
      const cell = wrap.querySelectorAll('.gcell')[i];
      const dot = cell && cell.querySelector('[data-live]');
      if (!dot) continue;
      const s = p ? byCwd.get(p.path) : null;
      if (!s || !s.alive) { dot.className = 'gcell-live'; dot.textContent = ''; continue; }
      const mins = Math.floor(s.quiet / 60);
      if (s.quiet < 25) { dot.className = 'gcell-live work'; dot.textContent = '● работает'; work++; }
      else { dot.className = 'gcell-live quiet'; dot.textContent = `тихо ${mins >= 1 ? mins + ' мин' : s.quiet + ' сек'}`; if (p && mins >= 1) quiet.push(p.name); }
    }
    const live = document.getElementById('gridLive');
    if (live) live.textContent = ss.length
      ? `${work} работают${quiet.length ? ' · тихо: ' + quiet.join(', ') : ''}`
      : 'каждая ячейка — свой проект и свой Claude';
  };
  void tick();
  gridPulseTimer = setInterval(tick, 5000);
}

function buildCell(i) {
  const cell = document.createElement('div');
  cell.className = 'gcell';
  const head = document.createElement('div');
  head.className = 'gcell-head';
  const sel = document.createElement('select');
  sel.className = 'gcell-sel';
  sel.innerHTML = optionsFor(i);
  const live = document.createElement('span');
  live.className = 'gcell-live'; live.setAttribute('data-live', '1');
  live.title = 'Работает — печатает прямо сейчас. «Тихо N мин» — либо ждёт твоего ответа, либо закончил (по молчанию не различить, поэтому честно пишем как есть).';
  const fresh = document.createElement('button');
  fresh.className = 'gcell-b'; fresh.textContent = '🆕'; fresh.title = 'новый диалог';
  const body = document.createElement('div');
  body.className = 'gcell-body';
  head.appendChild(sel); head.appendChild(live); head.appendChild(fresh);
  cell.appendChild(head); cell.appendChild(body);
  sel.addEventListener('change', () => { gridSel[i] = sel.value || null; saveGrid(); loadCell(body, gridSel[i], false); refreshGridSelects(); });
  fresh.addEventListener('click', () => { if (gridSel[i]) loadCell(body, gridSel[i], true); });
  loadCell(body, gridSel[i], false);
  return cell;
}

function loadCell(body, projId, fresh) {
  body.innerHTML = '';
  if (!projId) { body.innerHTML = `<div class="gcell-empty">выбери проект сверху</div>`; return; }
  if (!gridTermInfo || !gridTermInfo.available) { body.innerHTML = `<div class="gcell-empty">терминал недоступен</div>`; return; }
  const p = allProjects().find(x => x.id === projId);
  if (!p) return;
  const url = `http://127.0.0.1:${gridTermInfo.port}/?cwd=${encodeURIComponent(p.path)}&token=${gridTermInfo.token}${fresh ? '&fresh=1' : ''}`;
  const wv = document.createElement('webview');
  wv.className = 'gcell-wv';
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', 'true');
  // фокус на ячейку (навёл мышь / загрузилась), чтобы колесо-скролл истории claude
  // работало в ЛЮБОЙ ячейке, а не только куда кликнул (иначе Electron не шлёт wheel в webview)
  wv.addEventListener('mouseenter', () => { try { wv.focus(); } catch (_) {} });
  wv.addEventListener('dom-ready', () => { try { wv.focus(); } catch (_) {} });
  let tries = 0; const back = [120, 200, 320, 480, 650, 850];
  wv.addEventListener('did-fail-load', e => {
    if (e.errorCode && tries < back.length) { setTimeout(() => { try { wv.loadURL(url); } catch (_) {} }, back[tries++]); }
  });
  body.appendChild(wv);
}

function shortPath(p) {
  if (!current) return p;
  return p.startsWith(current.path) ? '…' + p.slice(current.path.length) : p;
}

// ─────────── страница проекта ───────────
async function renderOverview(dir, host) {
  if (!IS_APP) { renderBrowserNote(host); return; }
  const p = current;                       // фиксируем проект: после await current может смениться
  if (!p) return;
  const isRoot = dir === p.path;
  // два независимых запроса — параллельно, а не гуськом
  const [data, meta] = await Promise.all([
    API.overview(dir),
    isRoot ? API.getStatus(p.id, dir).catch(() => null) : Promise.resolve(null),
  ]);
  if (current !== p || !host.isConnected) return;   // ушли в другой проект, пока читали — не рисуем
  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  const page = document.createElement('div');
  page.className = 'page';

  const heading = isRoot ? p.name : ('…' + dir.slice(p.path.length));

  const nF = (data.folders || []).length, nFiles = (data.files || []).length;
  const wi = isRoot ? wallInfo(p) : null;
  let html = isRoot
    ? `<div class="cover" style="${wi.video ? '' : `background-image:url('${wi.url}')`}">
         ${wi.video ? `<video class="covervid" src="${wi.url}" autoplay muted loop playsinline></video>` : ''}
         <div class="wall-btns">
           <button class="wall-btn" data-a="wall" title="Поставить своё фото или видео на фон проекта">🖼 сменить фон</button>
           ${wi.custom ? `<button class="wall-btn ghost" data-a="wall-reset" title="Вернуть автоматический обой">вернуть авто</button>` : ''}
         </div>
         <div class="ctext"><div class="kick">проект</div><div class="ctitle">${esc(heading)}</div><div class="cpath">${esc(dir)}</div></div>
       </div>`
    : `<div class="subhead"><span class="st">${esc(heading)}</span><span class="sp">${esc(dir)}</span>
         <span class="sub-act" data-a="folder" title="Открыть в проводнике">↗</span>
         <span class="sub-act" data-a="systerm" title="Терминал системы в этой папке">❯_</span>
         <span class="sub-act" data-a="copypath" title="Скопировать путь">⧉</span></div>`;

  // статус-карточка проекта (простым языком, только на корне проекта)
  let needRefresh = false;
  if (isRoot) {
    if (meta && meta.data) html += renderStatusCard(meta.data);
    else if (meta && meta.hasSource) html += renderStatusCardPlaceholder();
    needRefresh = !!(meta && (meta.stale || (!meta.data && meta.hasSource)));
  }

  // действия: Панель/Терминал/Живьём вынесены во ВКЛАДКИ сверху; тут — работа с папкой
  html += `<div class="tiles">
    ${isRoot ? `<div class="tile accent" data-a="agent"><div class="tic">🤖</div><div class="tl">Задача агенту</div>
      <div class="ts">в фоне, в отдельной ветке</div></div>` : ''}
    ${isRoot && !p.board ? `<div class="tile" data-a="makeboard"><div class="tic">📊</div><div class="tl">Сделать пульт</div>
      <div class="ts">своя вкладка из шаблона, без кода</div></div>` : ''}
    <div class="tile" data-a="folder"><div class="tic">↗</div><div class="tl">Папка в проводнике</div>
      <div class="ts">${nF} папок · ${nFiles} файлов</div></div>
    <div class="tile" data-a="systerm"><div class="tic">❯_</div><div class="tl">Терминал системы</div></div>
    <div class="tile" data-a="copypath"><div class="tic">⧉</div><div class="tl">Скопировать путь</div></div>
  </div>`;

  // содержимое папки — по требованию (не описание, а навигация)
  if (data.error) {
    html += `<div class="msg">Не смог прочитать папку: ${esc(data.error)}</div>`;
  } else {
    html += `<div class="section-label">Содержимое папки</div><div class="files">`;
    for (const f of data.folders) html += `<div class="frow dir" data-dir="${esc(f)}"><span class="ic">▸</span><span class="fn">${esc(f)}</span></div>`;
    for (const f of data.files) html += `<div class="frow" data-file="${esc(f)}"><span class="ic">·</span><span class="fn">${esc(f)}</span></div>`;
    html += `</div>`;
  }

  page.innerHTML = html;
  scroll.appendChild(page);
  host.innerHTML = ''; host.appendChild(scroll);

  // события
  page.querySelectorAll('[data-a="folder"]').forEach(el => el.addEventListener('click', () => API.openFolder(dir)));
  page.querySelectorAll('[data-a="systerm"]').forEach(el => el.addEventListener('click', () => API.openFolderTerminal(dir)));
  page.querySelectorAll('[data-a="copypath"]').forEach(el => el.addEventListener('click', async () => {
    await API.copyPath(dir);
    el.classList.add('done'); setTimeout(() => el.classList.remove('done'), 900);
  }));
  page.querySelectorAll('[data-dir]').forEach(el =>
    el.addEventListener('click', () => pushView({ kind: 'overview', dir: joinPath(dir, el.dataset.dir) })));
  page.querySelectorAll('[data-file]').forEach(el =>
    el.addEventListener('click', () => pushView({ kind: 'file', path: joinPath(dir, el.dataset.file) })));
  page.querySelector('[data-a="refresh-status"]')?.addEventListener('click', () => autoRefreshStatus(p.id, dir, true));
  page.querySelector('[data-a="wall"]')?.addEventListener('click', () => changeWall(dir));
  page.querySelector('[data-a="wall-reset"]')?.addEventListener('click', () => resetWall(dir));
  page.querySelector('[data-a="agent"]')?.addEventListener('click', () => askAgentTask(p));
  page.querySelector('[data-a="makeboard"]')?.addEventListener('click', () => askBoardTemplate(p));

  // авто-подтяжка: журнал новее выжимки → сама обновит карточку в фоне
  if (needRefresh) autoRefreshStatus(p.id, dir, false);
}

// «Что я сделал» за период по ВСЕМ проектам: сел утром / переключил машину — за 5 секунд вспомнил,
// на чём остановился ВЕЗДЕ. Без ИИ: сообщения коммитов у владельца и так человеческие.
const DID_PERIODS = [{ d: 1, t: 'вчера' }, { d: 3, t: '3 дня' }, { d: 7, t: 'неделя' }, { d: 30, t: 'месяц' }];
let didDays = 1;
async function openDid(days) {
  didDays = days || didDays;
  const chips = DID_PERIODS.map(p => `<span class="ask-chip${p.d === didDays ? ' on' : ''}" data-d="${p.d}">${p.t}</span>`).join('');
  showModal('Что я сделал', `<div class="ask-presets" id="didChips">${chips}</div>
    <div id="didOut"><div class="msg"><span class="spin"></span> смотрю все проекты…</div></div>`,
    `<span class="board-act" data-a="did-copy">⧉ скопировать как текст</span>`);
  const wire = () => document.querySelectorAll('#didChips .ask-chip').forEach(c =>
    c.addEventListener('click', () => openDid(Number(c.dataset.d))));
  wire();
  const rows = IS_APP ? await API.didSince(didDays).catch(() => []) : [];
  const out = document.getElementById('didOut'); if (!out) return;
  if (!rows.length) {
    out.innerHTML = `<div class="msg">За этот период правок нет — отдыхал ✓</div>`;
  } else {
    out.innerHTML = rows.map(r => `<div class="snap-proj">
      <div class="snap-pname" style="--pc:${r.color}">${esc(r.name)}
        <span class="did-cnt">${r.total > r.items.length ? `${r.items.length} из ${r.total}` : r.items.length}</span></div>
      ${r.items.map(i => `<div class="sc-li"><span class="did-date">${esc(i.date)}</span> ${esc(i.text)}</div>`).join('')}
      ${r.total > r.items.length ? `<div class="set-hint" style="margin:4px 0 0 14px">…и ещё ${r.total - r.items.length} раньше — показаны последние ${r.items.length}</div>` : ''}
    </div>`).join('');
  }
  document.querySelector('[data-a="did-copy"]')?.addEventListener('click', async (e) => {
    const md = `# Что я сделал (${DID_PERIODS.find(p => p.d === didDays)?.t || didDays + ' дн'})\n\n` +
      rows.map(r => `## ${r.name}\n` + r.items.map(i => `- ${i.date} — ${i.text}`).join('\n') +
        (r.total > r.items.length ? `\n- …и ещё ${r.total - r.items.length} раньше (показаны последние ${r.items.length})` : '')).join('\n\n') + '\n';
    try { if (IS_APP) await API.copyPath(md); else await navigator.clipboard.writeText(md); e.target.textContent = '✓ скопировано'; }
    catch (_) { e.target.textContent = '⚠ не вышло'; }
    setTimeout(() => { e.target.textContent = '⧉ скопировать как текст'; }, 1400);
  });
}

// «Карта связей»: что на каком сервере/ключе висит. Не граф-спагетти, а таблица-указатель —
// смысл один: ПЕРЕД «заморожу/перееду сервер» увидеть, какие ещё проекты на нём держатся.
async function openLinksMap() {
  showModal('Карта связей', '<div class="msg"><span class="spin"></span> смотрю журналы проектов…</div>');
  const rows = IS_APP ? await API.linksMap().catch(() => []) : [];
  const body = document.querySelector('#modalBack .modal-body'); if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<div class="msg">Общих ресурсов не нашёл — похоже, проекты друг с другом не пересекаются
      (или адреса/ключи не упоминаются в журналах).</div>`;
    return;
  }
  body.innerHTML = `<div class="set-hint">Сервера и ключи, которые трогает БОЛЬШЕ ОДНОГО проекта. Загляни сюда
      перед тем, как что-то на сервере менять/переносить — сразу видно, что ещё на нём висит.
      Собрано из журналов и README (конфиги с секретами не читаю), так что список может быть неполным.</div>
    ${rows.map(r => `<div class="link-row">
      <div class="link-head"><span class="link-kind">${esc(r.kind)}</span><code class="link-res">${esc(r.resource)}</code>
        <span class="link-cnt">${r.hits.length} проекта(ов)</span></div>
      ${r.hits.map(h => `<div class="link-hit"><span class="link-proj">${esc(h.project)}</span>
        <span class="link-src">${esc(h.file)}:${h.line}</span></div>`).join('')}
    </div>`).join('')}`;
}

// «Сделать пульт»: выбрать готовый шаблон → положить штаб-борд.json в папку проекта (по клику владельца)
async function askBoardTemplate(p) {
  const tpls = IS_APP ? await API.boardTemplates().catch(() => []) : [];
  if (!tpls.length) return;
  showModal('Сделать пульт для «' + p.name + '»',
    `<div class="set-hint">Положу в папку проекта файл <code>штаб-борд.json</code> — и у него появится своя вкладка-пульт.
      Потом поправишь пути внутри под свои папки (подсказка в файле). Существующий пульт не трону.</div>
     <div class="tpl-list">${tpls.map(t => `<div class="tpl-row" data-k="${esc(t.key)}">
        <div class="tpl-name">${esc(t.name)}</div><div class="tpl-desc">${esc(t.desc)}</div></div>`).join('')}</div>
     <div id="tplOut"></div>`);
  document.querySelectorAll('.tpl-row').forEach(row => row.addEventListener('click', async () => {
    const out = document.getElementById('tplOut');
    const r = await API.boardCreate(p.path, row.dataset.k).catch(e => ({ error: String(e) }));
    if (r && r.ok) {
      out.innerHTML = `<div class="msg">✓ Готово — пульт создан. Открываю проект заново…</div>`;
      setTimeout(async () => { closeModal(); await reloadProjects(); const np = allProjects().find(x => x.id === p.id); if (np) openProject(np); }, 900);
    } else out.innerHTML = `<div class="msg">⚠ ${esc((r && r.error) || 'не вышло')}</div>`;
  }));
}

// сменить/вернуть фон проекта (свои фото/видео). После — перерисовать всё, где виден обой.
async function changeWall(dir) {
  if (!IS_APP || !current) return;
  const r = await API.pickWall(current.id).catch(() => null);
  if (!r) return;                                   // отменил диалог
  if (r.error) { alert('Не получилось поставить фон: ' + r.error); return; }
  customWalls[current.id] = r;
  afterWallChange(dir);
}
async function resetWall(dir) {
  if (!IS_APP || !current) return;
  await API.resetWall(current.id).catch(() => {});
  delete customWalls[current.id];
  afterWallChange(dir);
}
function afterWallChange(dir) {
  setWall(current);
  renderNav(); markActive(current.id);              // аватар в сайдбаре
  if (paneEls.overview) renderOverview(dir, paneEls.overview);   // обложка
}

// обновить статус из журнала через headless claude, заменить карточку на месте
async function autoRefreshStatus(id, dir, manual) {
  setStatusRefreshing(true);
  // status:refresh теперь отдаёт ТОТ ЖЕ промис, если прогон уже идёт (раньше возвращал
  // busy — и карточка навсегда оставалась на «готовлю выжимку…»)
  const r = await API.refreshStatus(id, dir).catch(() => ({ ok: false }));
  const v = stack[stack.length - 1];
  const stillHere = current && current.id === id && v && v.kind === 'overview' && v.dir === dir;
  if (!stillHere) return;
  if (r && r.ok) {
    const fresh = await API.getStatus(id, dir).catch(() => null);
    replaceStatusCard(fresh && fresh.data ? renderStatusCard(fresh.data) : '');
  } else {
    setStatusRefreshing(false);
    if (r && (r.reason === 'no-python' || r.reason === 'shot')) return;
    // прогон не удался — но выжимка могла обновиться другим путём; тихо перечитаем
    const fresh = await API.getStatus(id, dir).catch(() => null);
    if (fresh && fresh.data && !fresh.stale) replaceStatusCard(renderStatusCard(fresh.data));
  }
}

function setStatusRefreshing(on) {
  const el = document.querySelector('.status .sc-refresh');
  if (el) { el.textContent = on ? 'обновляю…' : 'обновить'; el.classList.toggle('busy', !!on); }
}

function replaceStatusCard(htmlStr) {
  const old = document.querySelector('.status');
  if (!old) return;
  if (!htmlStr) { old.remove(); return; }
  const tmp = document.createElement('div'); tmp.innerHTML = htmlStr;
  const neu = tmp.firstElementChild;
  old.replaceWith(neu);
  neu.querySelector('[data-a="refresh-status"]')?.addEventListener('click',
    () => autoRefreshStatus(current.id, current.path, true));
}

function renderStatusCardPlaceholder() {
  return `<div class="status"><div class="sc-top"><span class="sc-pill slow">…</span>` +
    `<span class="sc-pulse">Готовлю короткую выжимку из журнала…</span></div>` +
    `<div class="sc-foot"><span class="sc-refresh busy" data-a="refresh-status">обновляю…</span></div></div>`;
}

// статус-карточка: спокойная выжимка «где остановились», простым языком
function renderStatusCard(st) {
  const H = {
    ok:   { cls: 'ok',   label: 'идёт' },
    slow: { cls: 'slow', label: 'тихо' },
    stuck:{ cls: 'stuck',label: 'затык' },
  };
  const h = H[st.health] || H.slow;
  const list = (arr) => (arr || []).map(x => `<div class="sc-li">${inline(String(x))}</div>`).join('');
  const col = (title, arr, extra = '') =>
    (arr && arr.length) ? `<div class="sc-col ${extra}"><div class="sc-h">${title}</div>${list(arr)}</div>` : '';

  let cols = col('Сделали', st.done) + col('Дальше', st.next) + col('Ждём', st.waiting, 'wait');
  const changes = (st.changes && st.changes.length)
    ? `<div class="sc-changes"><span class="sc-ch-h">что менялось</span> ${st.changes.map(c => `<span class="sc-chip">${esc(String(c))}</span>`).join('')}</div>`
    : '';
  const upd = `<div class="sc-foot">${st.updated ? 'обновлено ' + esc(st.updated) + ' · ' : ''}<span class="sc-refresh" data-a="refresh-status">обновить</span></div>`;

  return `<div class="status">
    <div class="sc-top"><span class="sc-pill ${h.cls}">${h.label}</span>
      <span class="sc-pulse">${inline(st.pulse || '')}</span></div>
    ${cols ? `<div class="sc-cols">${cols}</div>` : ''}
    ${changes}${upd}
  </div>`;
}

function joinPath(dir, name) {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]$/, '') + sep + name;
}

// лёгкое оформление .md-выжимки (без внешних либ)
function renderDoc(doc) {
  const lines = doc.text.split('\n');
  let body = '';
  for (let raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^#{1,2}\s/.test(line))      body += `<h3>${inline(line.replace(/^#{1,2}\s/, ''))}</h3>`;
    else if (/^#{3,}\s/.test(line))  body += `<h4>${inline(line.replace(/^#{3,}\s/, ''))}</h4>`;
    else if (/^\s*[-*]\s/.test(line))body += `<div class="li">${inline(line.replace(/^\s*[-*]\s/, ''))}</div>`;
    else if (line.trim() === '')     body += '';
    else                             body += `<p>${inline(line)}</p>`;
  }
  const truncated = doc.text.length >= 16000 ? `<p class="fade">…показано начало документа. Открой файл целиком в списке ниже.</p>` : '';
  return `<div class="doc"><div class="docname">${esc(doc.name)}</div>${body}${truncated}</div>`;
}
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

// ─────────── просмотр файла ───────────
async function renderFile(p, host) {
  const data = await API.readFile(p);
  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  if (data.error) {
    scroll.innerHTML = `<div class="msg">${esc(data.error)}</div>`;
  } else {
    const isMd = /\.md$/i.test(p);
    const inner = isMd ? renderDoc({ name: data.name, text: data.text }) : `<pre>${esc(data.text)}</pre>`;
    scroll.innerHTML = `<div class="file-view"><div class="section-label">${esc(data.name)}</div>${inner}</div>`;
  }
  host.innerHTML = ''; host.appendChild(scroll);
}

// ─────────── живой сайт / терминал встроенным окном ───────────
function renderWeb(url, fixedAddr, host) {
  host.innerHTML = '';
  const wv = document.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', 'true');
  wv.addEventListener('mouseenter', () => { try { wv.focus(); } catch (_) {} });
  wv.addEventListener('dom-ready', () => { try { wv.focus(); } catch (_) {} updateNavButtons(); });
  host.appendChild(wv);
  webview = wv;
  if (!fixedAddr) {           // терминал не показывает свой url (в нём токен)
    const upd = u => { if (u) els.addrText.textContent = u; updateNavButtons(); };
    wv.addEventListener('did-navigate', e => upd(e.url));
    wv.addEventListener('did-navigate-in-page', e => upd(e.url));
  } else {                    // терминал: если страница не загрузилась (сайдкар ещё встаёт) — быстрый ретрай
    // мгновенный отклик: статус-плашка поверх, пока страница терминала не загрузилась
    const wait = document.createElement('div');
    wait.className = 'term-wait';
    wait.innerHTML = `<span class="spin"></span><span class="tw-msg">открываю терминал…</span>`;
    host.appendChild(wait);
    const gone = () => { try { wait.remove(); } catch (_) {} };
    wv.addEventListener('did-finish-load', gone);
    wv.addEventListener('did-navigate', gone);
    let tries = 0; const back = [120, 200, 320, 480, 650, 850, 1100, 1500, 2000, 2600];
    wv.addEventListener('did-fail-load', e => {
      if (!e.errorCode || webview !== wv) return;
      if (tries < back.length) {
        setTimeout(() => { try { wv.loadURL(url); } catch (_) {} }, back[tries++]);
      } else {
        wait.querySelector('.tw-msg').textContent =
          'терминал не отвечает — перезапусти ШТАБ; на маке проверь, что отработал Поднять-на-маке.command';
      }
    });
  }
}

function renderBrowserNote(host) {
  (host || els.stage).innerHTML = `<div class="placeholder"><div class="mark">!</div><h2>Это превью в браузере</h2><p>Полный просмотр папок, файлов и встроенных сайтов работает в самом приложении ШТАБ.</p></div>`;
}

// ─────────── борд из штаб-борд.json (конструктор: пульт проекта без кода) ───────────
async function renderJsonBoard(host) {
  const p = current; if (!p) return;
  host.innerHTML = `<div class="scroll"><div class="board"><div class="msg">Собираю пульт…</div></div></div>`;
  const man = IS_APP ? await API.boardManifest(p.path).catch(e => ({ error: String(e) })) : { error: 'только в приложении' };
  const box = host.querySelector('.board'); if (!box) return;
  if (man.error) { box.innerHTML = `<div class="msg">${esc(man.error)}</div>`; return; }
  box.innerHTML = `<div class="board-h"><span>${esc(man.title)}</span>
    <span class="board-act" data-a="reload">⟳ обновить</span></div>
    <div class="jb-blocks">${man.blocks.map((b, i) => `<div class="jb-block" data-i="${i}">
      ${b.label ? `<div class="section-label">${esc(b.label)}</div>` : ''}
      <div class="jb-body"><div class="msg">…</div></div></div>`).join('')}</div>`;
  box.querySelector('[data-a="reload"]')?.addEventListener('click', () => renderJsonBoard(host));
  man.blocks.forEach(async (b, i) => {
    const cell = box.querySelector(`.jb-block[data-i="${i}"] .jb-body`); if (!cell) return;
    const r = await API.boardBlock(p.path, b).catch(e => ({ error: String(e) }));
    if (!cell.isConnected) return;
    if (r.error) { cell.innerHTML = `<div class="msg">${esc(r.error)}</div>`; return; }
    if (r.kind === 'doc') cell.innerHTML = renderDoc({ name: r.name, text: r.text });
    else if (r.kind === 'metric') cell.innerHTML = `<div class="jb-metric"><div class="jb-num">${esc(r.value)}${r.suffix ? `<span class="jb-suf">${esc(r.suffix)}</span>` : ''}</div></div>`;
    else if (r.kind === 'cmd') {
      // Частая команда проекта под рукой. ШТАБ её САМ НЕ ЗАПУСКАЕТ (манифест может приехать из
      // чужого форка) — показывает как есть, копирует и открывает терминал: Enter жмёшь ты, видя текст.
      cell.innerHTML = `<div class="jb-cmd"><code class="jb-cmdline">${esc(r.cmd)}</code>
        <div class="jb-cmdacts"><span class="board-act" data-a="cmd-copy">⧉ скопировать</span>
          <span class="board-act" data-a="cmd-term">❯ открыть терминал</span></div>
        <div class="set-hint">ШТАБ ничего не запускает сам — скопируй, вставь в терминал и нажми Enter, когда прочитал.</div></div>`;
      cell.querySelector('[data-a="cmd-copy"]').addEventListener('click', (e) => {
        API.copyPath(r.cmd); e.target.textContent = '✓ скопировано';
        setTimeout(() => { e.target.textContent = '⧉ скопировать'; }, 1200);
      });
      cell.querySelector('[data-a="cmd-term"]').addEventListener('click', () => { API.copyPath(r.cmd); selectTab('term'); });
    }
    else if (r.kind === 'pre') cell.innerHTML = `<div class="file-view" style="padding:0"><pre>${esc(r.text || 'пусто')}</pre></div>`;
    else if (r.kind === 'web') {
      cell.innerHTML = '';
      const wv = document.createElement('webview');
      wv.className = 'jb-wv'; wv.setAttribute('src', r.url); wv.setAttribute('allowpopups', 'true');
      cell.appendChild(wv);
    } else if (r.kind === 'url-click') {
      // внешний адрес из недоверенного манифеста — грузим ТОЛЬКО по клику, показав домен
      cell.innerHTML = `<div class="jb-urlclick"><span class="msg">Внешний сайт: <b>${esc(r.host)}</b></span>
        <button class="board-act" data-a="openurl">▶ открыть здесь</button></div>`;
      cell.querySelector('[data-a="openurl"]').addEventListener('click', () => {
        cell.innerHTML = '';
        const wv = document.createElement('webview');
        wv.className = 'jb-wv'; wv.setAttribute('src', r.url); wv.setAttribute('allowpopups', 'true');
        cell.appendChild(wv);
      });
    }
  });
}

// ─────────── борд «Питон-школа»: XP + карта уровней + кнопка «Играть» (claude-гейм-мастер) ───────────
async function renderSchoolBoard(host) {
  const p = current; if (!p) return;
  host.innerHTML = `<div class="scroll"><div class="board"><div class="msg">Открываю класс…</div></div></div>`;
  const inf = IS_APP ? await API.schoolInfo(p.path).catch(() => null) : null;
  if (!inf) { const b0 = host.querySelector('.board'); if (b0) b0.innerHTML = '<div class="msg">Работает только в приложении.</div>'; return; }
  // у школы есть СВОЙ готовый апп → встраиваем его целиком (плавно, его же дизайн, по кнопкам),
  // сверху тонкая панель с «▶ играть» (гейм-мастер в терминале) и «⟳»
  if (inf.appUrl) {
    host.innerHTML = `<div class="sch-wrap">
        <div class="sch-bar"><span class="sch-bar-t">🎮 Питон-школа</span>
          ${inf.xp != null ? `<span class="sch-bar-xp">${inf.xp} XP · ур. ${esc(inf.level || '—')} · стрик ${esc(inf.streak || '—')}</span>` : ''}
          <span class="sch-bar-acts"><span class="board-act" data-a="play">▶ играть с наставником</span>
            <span class="board-act" data-a="reload">⟳</span></span></div>
        <div class="sch-app"></div></div>`;
    const wv = document.createElement('webview');
    wv.className = 'sch-frame'; wv.setAttribute('src', inf.appUrl); wv.setAttribute('allowpopups', 'true');
    host.querySelector('.sch-app').appendChild(wv);
    host.querySelector('[data-a="reload"]')?.addEventListener('click', () => { try { wv.reload(); } catch (_) {} });
    host.querySelector('[data-a="play"]')?.addEventListener('click', () => {
      pendingTermSay = 'играю';
      paneReady.term = false; if (paneEls.term) { paneEls.term.remove(); delete paneEls.term; }
      selectTab('term');
    });
    return;
  }
  const box = host.querySelector('.board'); if (!box) return;
  box.innerHTML = `<div class="board-h"><span>🎮 Питон-школа</span>
      <span class="board-act" data-a="reload">⟳</span></div>
    <div class="sch-hero">
      <div class="sch-stats">
        <div class="sch-stat"><div class="sch-num">${inf.xp ?? '—'}</div><div class="sch-cap">XP</div></div>
        <div class="sch-stat"><div class="sch-num">${esc(inf.level || '—')}</div><div class="sch-cap">уровень</div></div>
        <div class="sch-stat"><div class="sch-num">${esc(inf.streak || '—')}</div><div class="sch-cap">стрик</div></div>
      </div>
      <button class="sch-play" data-a="play">▶ Играть</button>
      <div class="set-hint">Кнопка откроет терминал и сама скажет гейм-мастеру «играю» — он продолжит с твоего места.</div>
    </div>
    ${inf.levels.length ? `<div class="section-label">Уровни</div><div class="tgroup">${inf.levels.map(f =>
      `<div class="titem sr-hit" data-file="${esc(f)}">📗 ${esc(f.replace(/\.md$/i, '').replace(/_/g, ' '))}</div>`).join('')}</div>` : ''}
    ${inf.progress ? `<div class="section-label" style="margin-top:16px">Прогресс</div>${renderDoc({ name: 'ПРОГРЕСС.md', text: inf.progress })}` : ''}`;
  box.querySelector('[data-a="reload"]')?.addEventListener('click', () => renderSchoolBoard(host));
  box.querySelector('[data-a="play"]')?.addEventListener('click', () => {
    pendingTermSay = 'играю';
    paneReady.term = false;               // пересоздать терминал-вкладку с авто-фразой
    if (paneEls.term) { paneEls.term.remove(); delete paneEls.term; }
    selectTab('term');
  });
  box.querySelectorAll('.sr-hit').forEach(el => el.addEventListener('click', () => {
    pushView({ kind: 'file', path: joinPath(p.path, el.dataset.file) });
    selectTab('overview');
  }));
}

// ─────────── плавное движение фона и карточек за курсором ───────────
document.addEventListener('mousemove', e => {
  const mx = e.clientX / innerWidth - .5, my = e.clientY / innerHeight - .5;
  bgs.forEach(b => { b.style.transform = `scale(1.08) translate(${mx * -14}px, ${my * -10}px)`; });
  const cover = els.stage.querySelector('.cover'); if (cover) cover.style.transform = `translate(${mx * 8}px, ${my * 6}px)`;
  const st = els.stage.querySelector('.status'); if (st) st.style.transform = `translate(${mx * 5}px, ${my * 4}px)`;
});

// ─────────── тулбар ───────────
els.back.addEventListener('click', back);
els.fwd.addEventListener('click', fwd);
els.reload.addEventListener('click', () => {
  if (!current) { rerenderGlobalScreen(); return; }   // на глобальных экранах вкладок нет — там свой перерисов
  // активная вкладка = webview (терминал/живьём/хаб) → перезагрузить; иначе перерисовать текущую вкладку
  const wv = paneEls[activeTab] && paneEls[activeTab].querySelector('webview');
  if (wv) { try { wv.reload(); } catch (_) {} return; }
  if (activeTab === 'overview' && paneEls.overview) renderOverviewTab(paneEls.overview);
  else if (activeTab && paneEls[activeTab]) { paneReady[activeTab] = false; selectTab(activeTab); }
});

// глобальные экраны (обзор/хвосты/агенты/поиск/расход/синхра/настройки/стена) — не проектные:
// у них нет вкладок, ⟳ должна просто перерисовать текущий
let globalScreen = null;   // функция перерисовки активного глобального экрана
function enterGlobal(fn) {
  globalScreen = fn;
  current = null; stack = []; webview = null; activeTab = null;
  for (const k in paneEls) delete paneEls[k];
  for (const k in paneReady) delete paneReady[k];
}
function rerenderGlobalScreen() { if (globalScreen) try { globalScreen(); } catch (_) {} }

// ─────────── заметки ───────────
els.notesBtn.addEventListener('click', () => {
  const open = els.notes.classList.toggle('open');
  els.notesBtn.classList.toggle('on', open);
  if (open) els.notesText.focus();
});
let saveTimer = null;
els.notesText.addEventListener('input', () => {
  els.savedMark.textContent = '…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNotes, 500);
});
let notesSyncTimer = null;
async function saveNotes() {
  const text = els.notesText.value;
  if (API) {
    const ok = await API.saveNotes(text).catch(() => false);
    els.savedMark.textContent = ok ? 'сохранено' : '⚠ не сохранилось — файл занят?';
    if (ok) scheduleNotesSync();
    return;
  }
  localStorage.setItem('shtab.notes', text);
  els.savedMark.textContent = 'сохранено';
}
// Заметки тоже ездят между устройствами: тихий коммит (хук пушит). Дебаунс 8с после последней правки.
function scheduleNotesSync() {
  if (!IS_APP) return;
  clearTimeout(notesSyncTimer);
  notesSyncTimer = setTimeout(() => { API.notesSync().catch(() => {}); }, 8000);
}
async function loadNotes() {
  let text = '';
  if (API) text = await API.loadNotes(); else text = localStorage.getItem('shtab.notes') || '';
  els.notesText.value = text || '';
}

// ─────────── синхра-светофор (всё ли уехало на сервер 213) ───────────
els.syncBtn.addEventListener('click', openSync);

let lastSyncOut = '';   // вывод последней авто-синхры (для панели)
function openSync() {
  enterGlobal(openSync);
  markActive('__sync__');
  els.title.textContent = 'Синхра';
  els.addrText.textContent = '';
  els.back.style.opacity = '.35';
  els.stage.innerHTML = `<div class="scroll"><div class="sync">
    <div class="sync-auto">🔄 Синхронизируется <b>сама</b> — тянет свежее с сервера при запуске и когда возвращаешься в окно. Жать ничего не надо. <span class="sync-refresh" data-a="sync-now">обновить сейчас</span></div>
    ${lastSyncOut ? `<pre class="sync-out">${esc(lastSyncOut)}</pre>` : ''}
    <div id="syncLight"><div class="sync-h">Проверяю, всё ли уехало на сервер…</div></div>
  </div></div>`;
  els.stage.querySelector('[data-a="sync-now"]')?.addEventListener('click', () => autoSync(true));
  refreshSyncLight();
}

// авто-подгрузка свежего с сервера (git pull всех проектов). silent=false → потом открыть панель.
let syncing = false, lastPullTs = 0;
async function autoSync(openPanel) {
  if (!IS_APP || syncing) return;
  syncing = true; lastPullTs = Date.now();
  els.syncBtn.classList.add('syncing');
  // параллельный git pull всех репо (быстро, без интерактивных SSH-вопросов) вместо серийного скрипта
  const r = await API.syncPull().catch(e => ({ ok: false, out: String((e && e.message) || e) }));
  els.syncBtn.classList.remove('syncing');
  syncing = false;
  lastSyncOut = (r && r.out) || '';
  if (r && r.ok) {
    try { projects = await API.listProjects(); renderNav(); if (current) markActive(current.id); } catch (_) {}
    // подхватить свежие заметки с другого устройства — но не затирать, если сейчас в них печатаю
    if (document.activeElement !== els.notesText) { try { await loadNotes(); } catch (_) {} }
  }
  if (openPanel) openSync();
  else if (document.getElementById('syncLight')) refreshSyncLight();
}

// «данные от 12:04» — светофор обязан честно говорить, НАСКОЛЬКО свежи его сведения о сервере
function fetchedLabel(ts, failed) {
  const hhmm = ts ? (() => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; })() : '';
  // сервер не ответил — говорим это прямо. Молчаливое «сверено» при мёртвой сети хуже, чем его отсутствие.
  if (failed) return ts ? `⚠ сервер не ответил — данные от ${hhmm}, могли устареть` : '⚠ сервер не ответил — сверки не было';
  if (!ts) return 'сервер ещё не спрашивали';
  return Math.floor((Date.now() - ts) / 60000) < 1 ? 'сверено с сервером только что' : `сверено с сервером в ${hhmm}`;
}
async function refreshSyncLight() {
  let res = null;
  try { res = API ? await API.syncStatus() : null; } catch (_) { res = null; }
  const box = document.getElementById('syncLight'); if (!box) return;
  if (!res || !res.rows) { box.innerHTML = `<div class="sync-h">Не получилось проверить (git недоступен).</div>`; return; }
  const cl = res.rows.map(r => ({ r, c: classifySync(r) }));
  const bad = cl.filter(x => x.c.cls === 'bad');            // разошлось — тут теряется работа
  const problems = cl.filter(x => x.c.cls === 'warn');
  const okCount = cl.filter(x => x.c.cls === 'ok').length;
  // без успешной сверки «можно спокойно переходить» — обещание, которого мы не можем дать
  const unsure = !res.fetchedAt || res.fetchFailed;
  const head = bad.length
    ? `<div class="sync-sum bad">⛔ РАЗОШЛОСЬ: ${bad.length} — правили и здесь, и на другой машине. Разберись с ними до того, как продолжать.</div>`
    : problems.length === 0
      ? (unsure
        ? `<div class="sync-sum warn">Здесь всё закоммичено и отправлено, но с сервером сверить не вышло — не поручусь, что на другой машине нет новее.</div>`
        : `<div class="sync-sum ok">✓ Всё на сервере. Можно спокойно переходить на другую машину.</div>`)
      : `<div class="sync-sum warn">⚠ Требует внимания: ${problems.length} — ниже жёлтым. Остальные ${okCount} на сервере.</div>`;
  const rowsHtml = cl.map(({ r, c }) =>
    `<div class="sync-row"><span class="sync-dot ${c.cls}"></span><span class="sync-name">${esc(r.name)}</span>
      <span class="sync-state ${c.cls}">${esc(c.label)}</span>
      ${c.cls === 'bad' ? `<span class="board-act" data-diverge="${esc(r.id)}">разобрать</span>` : ''}</div>`).join('');
  box.innerHTML = `${head}
    <div class="sync-hint">Светофор сверяется с сервером сам (тихо, раз в несколько минут — только смотрит, ничего не качает).
      «не отправлено» = твои правки ещё тут; «на сервере новее» = сначала load; «разошлось» = правили с двух машин одно и то же.</div>
    <div class="sync-list">${rowsHtml}</div>
    <div class="sync-foot"><span class="sync-fresh${res.fetchFailed ? ' warn' : ''}">${esc(fetchedLabel(res.fetchedAt, res.fetchFailed))}</span>
      <span class="sync-acts"><span class="sync-refresh" data-a="sync-refresh">спросить сервер сейчас</span>
        <button class="foot-btn sync-go" data-a="sync-push">🧳 Уезжаю с этой машины</button></span></div>`;
  box.querySelector('[data-a="sync-refresh"]')?.addEventListener('click', async () => {
    const f = box.querySelector('.sync-fresh'); if (f) f.textContent = 'спрашиваю сервер…';
    if (IS_APP && API.syncFetch) await API.syncFetch().catch(() => {});
    refreshSyncLight();
  });
  box.querySelector('[data-a="sync-push"]')?.addEventListener('click', openSyncPush);
  box.querySelectorAll('[data-diverge]').forEach(el =>
    el.addEventListener('click', () => openDiverge(el.dataset.diverge)));
}

// Разбор «разошлось»: раньше тут был тупик — красное «нужен ты» и всё. Показываем ФАКТЫ
// (чьи коммиты, какие файлы спорят) и отдаём claude в этой папке. Автослияния по-прежнему НЕТ.
async function openDiverge(id) {
  showModal('Разошлось — разберём', '<div class="msg"><span class="spin"></span> смотрю, что где…</div>');
  const r = IS_APP ? await API.syncDiverge(id).catch(() => null) : null;
  const body = document.querySelector('#modalBack .modal-body'); if (!body) return;
  if (!r || r.error) { body.innerHTML = `<div class="msg">${esc((r && r.error) || 'не вышло')}</div>`; return; }
  const list = (arr) => arr.length
    ? arr.map(i => `<div class="sc-li"><span class="did-date">${esc(i.date)}</span> ${esc(i.text)}</div>`).join('')
    : '<div class="set-hint">— нет —</div>';
  body.innerHTML = `<div class="set-hint">Проект <b>${esc(r.name)}</b>: правил и здесь, и на другой машине.
      Ничего не сливаю сам — сначала посмотри, что где, и реши.</div>
    <div class="snap-proj"><div class="snap-pname" style="--pc:var(--pc)">Тут, у тебя (${r.ahead})</div>${list(r.mine)}</div>
    <div class="snap-proj"><div class="snap-pname" style="--pc:var(--pc)">На сервере, с другой машины (${r.behind})</div>${list(r.theirs)}</div>
    <div class="snap-proj"><div class="snap-pname" style="--pc:${r.conflict.length ? 'var(--bad)' : 'var(--ok)'}">
        ${r.conflict.length ? `Спорят файлы (${r.conflict.length})` : 'Общих файлов не трогали — сольётся легко'}</div>
      ${r.conflict.map(f => `<div class="sc-li"><code>${esc(f)}</code></div>`).join('')}</div>`;
  const foot = document.querySelector('#modalBack .modal-foot')
    || (() => { const f = document.createElement('div'); f.className = 'modal-foot';
                document.querySelector('#modalBack .modal').appendChild(f); return f; })();
  foot.innerHTML = `<span class="board-act" data-a="dv-copy">⧉ скопировать разбор</span>
    <button class="foot-btn" data-a="dv-claude">🤖 Разобрать со мной в терминале</button>`;
  const md = `Помоги разобраться: проект «${r.name}» разошёлся между двумя машинами.\n` +
    `Тут мои коммиты (${r.ahead}):\n${r.mine.map(i => `- ${i.date} ${i.text}`).join('\n') || '—'}\n\n` +
    `На сервере с другой машины (${r.behind}):\n${r.theirs.map(i => `- ${i.date} ${i.text}`).join('\n') || '—'}\n\n` +
    (r.conflict.length ? `Оба тронули файлы:\n${r.conflict.map(f => `- ${f}`).join('\n')}\n\n` : 'Общих файлов не трогали.\n\n') +
    `Объясни простым языком, что произошло и какие есть варианты. Ничего не делай без моего слова.`;
  foot.querySelector('[data-a="dv-copy"]').addEventListener('click', (e) => {
    API.copyPath(md); e.target.textContent = '✓ скопировано';
  });
  foot.querySelector('[data-a="dv-claude"]').addEventListener('click', () => {
    API.copyPath(md); closeModal();
    const p = allProjects().find(x => x.id === id);
    if (p) { openProject(p); selectTab('term'); }   // разбор уже в буфере — вставь и спроси
  });
}

// «Уезжаю с этой машины»: СНАЧАЛА показываем, что именно уедет (файлы!), и только по кнопке шлём.
// Ничего не отправляется молча — это правка твоих проектов, ты должен видеть, что уходит.
async function openSyncPush() {
  showModal('Уезжаю с этой машины', '<div class="msg"><span class="spin"></span> смотрю, что не уехало…</div>');
  const rows = IS_APP ? await API.syncPreview().catch(() => []) : [];
  const body = document.querySelector('#modalBack .modal-body'); if (!body) return;
  const send = rows.filter(r => !r.diverged && !r.needPull);
  const diverged = rows.filter(r => r.diverged);
  const needPull = rows.filter(r => r.needPull);
  if (!send.length && !diverged.length && !needPull.length) {
    body.innerHTML = '<div class="msg">✓ Всё уже на сервере — можно спокойно уходить.</div>'; return;
  }
  body.innerHTML =
    (diverged.length ? `<div class="sync-sum bad" style="margin-bottom:14px">⛔ Не трогаю: ${diverged.map(d => esc(d.name)).join(', ')} —
       разошлось (правил и тут, и на другой машине). Тут нужен ты, автоматом сливать опасно.</div>` : '') +
    (needPull.length ? `<div class="sync-sum warn" style="margin-bottom:14px">⚠ Сначала забери с сервера:
       ${needPull.map(d => `${esc(d.name)} (там новее на ${d.behind})`).join(', ')}.
       Если закоммитить сейчас — как раз и получится «разошлось». Нажми «Забрать с сервера» в панели Синхры, потом вернись сюда.</div>` : '') +
    (send.length ? `<div class="set-hint">Закоммичу и отправлю на сервер вот это. Посмотри, ничего лишнего?</div>
      ${send.map(r => `<div class="snap-proj"><div class="snap-pname" style="--pc:var(--pc)">
        <label class="push-lbl"><input type="checkbox" class="push-cb" data-id="${esc(r.id)}" checked> ${esc(r.name)}</label>
        <span class="did-cnt">${r.dirty ? `${r.dirty} правок` : ''}${r.dirty && r.ahead ? ' · ' : ''}${r.ahead ? `${r.ahead} не отправлено` : ''}</span></div>
        ${(r.files || []).map(f => `<div class="sc-li"><code>${esc(f)}</code></div>`).join('')}
        ${r.dirty > (r.files || []).length ? `<div class="set-hint" style="margin-left:14px">…и ещё ${r.dirty - r.files.length}</div>` : ''}
      </div>`).join('')}` : '') +
    `<div id="pushOut"></div>`;
  const foot = document.querySelector('#modalBack .modal-foot') || (() => {
    const f = document.createElement('div'); f.className = 'modal-foot';
    document.querySelector('#modalBack .modal').appendChild(f); return f;
  })();
  if (send.length) {
    foot.innerHTML = `<button class="foot-btn" data-a="go">Отправить на сервер</button>`;
    foot.querySelector('[data-a="go"]').addEventListener('click', async (e) => {
      const ids = [...document.querySelectorAll('.push-cb:checked')].map(c => c.dataset.id);
      if (!ids.length) return;
      e.target.textContent = 'Отправляю…'; e.target.disabled = true;
      const res = await API.syncPush(ids).catch(() => []);
      const out = document.getElementById('pushOut');
      if (out) out.innerHTML = `<div class="push-res">${res.map(r => `<div class="${r.ok ? 'push-ok' : 'push-bad'}">
        ${r.ok ? '✓' : '✗'} ${esc(r.name)}${r.err ? ' — ' + esc(r.err) : ''}</div>`).join('')}</div>`;
      e.target.textContent = res.every(r => r.ok) ? '✓ Уехало' : 'Часть не уехала';
      refreshSyncLight();
    });
  }
}

// Светофор словами, а не «ок/не ок». Главное состояние — РАЗОШЛОСЬ (ahead И behind): только там
// реально теряется работа при двух машинах, и оно обязано быть видно сразу.
function classifySync(r) {
  if (!r || !r.isRepo) return { cls: 'off', label: 'не под синхрой' };
  if (r.error) return { cls: 'off', label: 'не смог проверить' };
  if (!r.hasUpstream) return { cls: 'off', label: 'нет привязки к серверу' };
  if (r.ahead > 0 && r.behind > 0) return { cls: 'bad', label: `разошлось: ${r.ahead} тут / ${r.behind} на сервере` };
  const bits = [];
  // behind ОБЯЗАН быть в общем списке: раньше он проверялся ПОСЛЕ раннего return и терялся,
  // если тут были незакоммиченные правки — а это самый опасный случай (коммит сделает «разошлось»)
  if (r.behind > 0) bits.push(`на сервере новее: ${r.behind} — сначала забери`);
  if (r.dirty > 0) bits.push(`${r.dirty} не сохранено`);
  if (r.ahead > 0) bits.push(`не отправлено: ${r.ahead}`);
  if (bits.length) return { cls: 'warn', label: bits.join(' · ') };
  return { cls: 'ok', label: 'всё на сервере' };
}

els.settingsBtn.addEventListener('click', openSettings);

async function openSettings() {
  enterGlobal(openSettings);
  markActive('__settings__');
  els.title.textContent = 'Настройки'; els.addrText.textContent = '';
  els.back.style.opacity = '.35';
  els.stage.innerHTML = `<div class="scroll"><div class="dash">
    <div class="dash-h">Настройки</div>
    <div class="tgroup"><div class="tgname"><span class="tgdot" style="background:var(--pc)"></span>Папки с проектами</div>
      <div class="set-hint">ШТАБ показывает проекты из этих папок (каждая подпапка = проект). Можно добавить несколько.</div>
      <div id="rootList"></div>
      <div class="set-actions"><span class="board-act" data-a="add-root">＋ добавить папку</span>
        <span class="board-act" id="demoBtn" hidden></span></div>
    </div>
    <div class="tgroup"><div class="tgname"><span class="tgdot" style="background:var(--pc)"></span>Окружение</div>
      <div class="set-hint">Что ШТАБ нашёл на этой машине. Если чего-то нет — терминал и ИИ-выжимки не заработают.</div>
      <div id="envBox"><div class="msg">…</div></div>
    </div>
    <div class="tgroup" id="phoneGroup"><div class="tgname"><span class="tgdot" style="background:var(--pc)"></span>Открыть с телефона</div>
      <div class="set-hint">Тот же ШТАБ с телефона — на одной сети/VPN с этим компом. Наведи камеру телефона на QR.
        Доступ только по секретной ссылке (QR); наружу в интернет ничего не открывается. Пока окно закрыто — пульт выключен.</div>
      <div id="phoneBox"><div class="msg">…</div></div>
    </div></div></div>`;
  els.stage.querySelector('[data-a="add-root"]').addEventListener('click', async () => {
    const roots = IS_APP ? await API.settingsAddRoot().catch(() => null) : null;
    if (roots) { await reloadProjects(); renderRootList(roots); }
  });
  const s = IS_APP ? await API.settingsGet().catch(() => null) : null;
  renderRootList(s ? s.roots : []);
  renderPhone();
  renderEnv();
  renderDemoBtn();
}

// демо включается одной кнопкой — и выключаться должно так же, иначе чужие демо-проекты
// останутся в списке владельца навсегда
async function renderDemoBtn() {
  const b = document.getElementById('demoBtn'); if (!b || !IS_APP || !API.demoIsOn) return;
  const st = await API.demoIsOn().catch(() => null);
  if (!st || !st.has) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = st.on ? '✕ убрать демо-проекты' : '▶ показать демо-проекты';
  b.onclick = async () => {
    b.textContent = '…';
    await (st.on ? API.demoOff() : API.demoOn()).catch(() => {});
    await reloadProjects();
    openSettings();
  };
}

// «Окружение» — чтобы «нет выжимки» и «терминал не поднимается» перестали быть загадкой
async function renderEnv() {
  const box = document.getElementById('envBox'); if (!box) return;
  if (!IS_APP || !API.envCheck) { box.innerHTML = '<div class="msg">Только в приложении.</div>'; return; }
  const e = await API.envCheck().catch(() => null);
  if (!e) { box.innerHTML = '<div class="msg">Не смог проверить.</div>'; return; }
  const row = (name, v, what) => `<div class="env-row">
    <span class="env-dot ${v.ok ? 'ok' : 'bad'}"></span><span class="env-name">${esc(name)}</span>
    <span class="env-val">${v.ok ? `<code>${esc(v.path || 'найден')}</code>` : esc(v.hint || 'не найден')}</span>
    <span class="env-what">${esc(what)}</span></div>`;
  box.innerHTML = row('Питон', e.python, 'терминал и ИИ-выжимки')
    + row('Claude', e.claude, 'терминал, выжимки, агенты')
    + (e.agents && e.agents.length ? `<div class="set-hint" style="margin-top:8px">Ещё найдены: ${e.agents.map(esc).join(', ')}</div>` : '');
}

// ─────────── «Открыть с телефона»: включает веб-пульт и рисует QR со ссылкой ───────────
async function renderPhone() {
  const box = document.getElementById('phoneBox'); if (!box) return;
  if (!IS_APP || !API.webStatus) { box.innerHTML = '<div class="msg">Доступно только в приложении на компе.</div>'; return; }
  const st = await API.webStatus().catch(() => ({ on: false }));
  if (!st || !st.on) {
    box.innerHTML = `<div class="set-actions"><span class="board-act" data-a="web-on">📱 Включить пульт для телефона</span></div>`;
    box.querySelector('[data-a="web-on"]').addEventListener('click', async () => {
      box.innerHTML = '<div class="msg">Запускаю…</div>';
      const r = await API.webStart().catch(() => ({ on: false }));
      if (r && r.on) renderPhone(); else box.innerHTML = `<div class="msg">Не удалось включить${r && r.error ? ': ' + esc(r.error) : ''}.</div>`;
    });
    return;
  }
  // У компа несколько адресов: VPN (работает из ЛЮБОЙ сети, если телефон в том же VPN) и
  // локальные (только когда телефон в той же Wi-Fi). VPN показываем ПЕРВЫМ — он надёжнее.
  const isVpn = (a) => /amnezia|hamachi|wireguard|\bwg\b|vpn|tun|tap|zerotier|tailscale/i.test(a.name || '');
  const isLan = (a) => /^192\.168\./.test(a.address || '') || /^172\.(1[6-9]|2\d|3[01])\./.test(a.address || '') || /wi-?fi|ethernet|wlan|lan/i.test(a.name || '');
  const rank = (a) => isVpn(a) ? 0 : (isLan(a) ? 1 : 2);
  const addrs = (st.addresses || []).slice().sort((a, b) => rank(a) - rank(b));
  const cards = addrs.map((a, i) => {
    const url = `http://${a.address}:${st.port}/?t=${st.token}`;
    let qrHtml = '';
    try { const qr = qrcode(0, 'M'); qr.addData(url); qr.make(); qrHtml = qr.createImgTag(4, 6); } catch (_) {}
    const tag = isVpn(a) ? 'через VPN · из любой сети' : (isLan(a) ? 'дома · тот же Wi-Fi' : 'сеть');
    return `<div class="phone-card${i === 0 ? ' primary' : ''}">
        <div class="phone-qr">${qrHtml || '<div class="msg">—</div>'}</div>
        <div class="phone-cap"><b>${esc(a.name)}</b><span class="phone-tag">${tag}</span>
          <code>${esc(a.address)}:${st.port}</code>
          <span class="board-act" data-copy="${esc(url)}">⧉ ссылка</span></div>
      </div>`;
  }).join('') || '<div class="msg">Нет сетевых адресов — комп не в сети?</div>';
  const hasVpn = addrs.some(isVpn);
  box.innerHTML = `<div class="phone-live" style="margin-bottom:12px"><span class="dpill ok">включён</span>
      ${hasVpn ? 'Поставь VPN на телефон (тот же, что на компе) и бери QR «через VPN» — работает из любой сети.'
               : 'Наведи камеру телефона на QR. Телефон должен быть в той же Wi-Fi, что и комп.'}
      <span class="board-act" data-a="web-off" style="margin-left:8px">выключить</span></div>
    <div class="phone-cards">${cards}</div>
    <div class="set-hint" style="margin-top:10px">Не открывается? 1) телефон и комп в одной сети (или в одном VPN);
      2) если Windows спросит про брандмауэр — «Разрешить»; 3) попробуй QR другого адреса.</div>`;
  box.querySelector('[data-a="web-off"]').addEventListener('click', async () => { await API.webStop().catch(() => {}); renderPhone(); });
  box.querySelectorAll('[data-copy]').forEach(el => el.addEventListener('click', () => {
    API.copyPath(el.dataset.copy); const o = el.textContent; el.textContent = '✓'; setTimeout(() => { el.textContent = o; }, 1000);
  }));
}

function renderRootList(roots) {
  const box = document.getElementById('rootList'); if (!box) return;
  box.innerHTML = (roots || []).map(r => `<div class="set-root"><code>${esc(r)}</code>
      ${roots.length > 1 ? `<span class="set-x" data-dir="${esc(r)}" title="Убрать папку (проекты не удаляются)">✕</span>` : ''}</div>`).join('')
    || '<div class="msg">Папок нет — добавь, где лежат проекты.</div>';
  box.querySelectorAll('.set-x').forEach(el => el.addEventListener('click', async () => {
    const roots2 = await API.settingsRemoveRoot(el.dataset.dir).catch(() => null);
    if (roots2) { await reloadProjects(); renderRootList(roots2); }
  }));
}

async function reloadProjects() {
  try {
    const [pr, gr] = await Promise.all([API.listProjects(), API.groupList().catch(() => null)]);
    projects = pr;
    if (Array.isArray(gr) && gr.length) navGroups = gr;
    renderNav();
  } catch (_) {}
}

// ─────────── фоновые агенты: дал задачу → работает в отдельной ветке → дифф → принять ───────────
const AG_ST = {
  running: { c: 'slow', t: 'работает' }, done: { c: 'ok', t: 'готово — посмотри' },
  error: { c: 'stuck', t: 'ошибка' }, accepted: { c: 'ok', t: 'принято' }, rejected: { c: 'off', t: 'отклонено' },
};

async function refreshAgentBadge() {
  if (!IS_APP || !API.agentList) return;
  const tasks = await API.agentList().catch(() => []);
  const hot = tasks.filter(t => t.status === 'running' || t.status === 'done').length;
  const b = document.getElementById('agentBadge'); if (!b) return;
  b.style.display = hot ? '' : 'none'; b.textContent = hot;
}
// счётчик проектов, у которых есть хвосты (next/waiting) — сразу видно, много ли недоделок
async function refreshTailBadge() {
  if (!IS_APP || !API.tailsList) return;
  const rows = await API.tailsList().catch(() => []);
  const b = document.getElementById('tailBadge'); if (!b) return;
  b.style.display = rows.length ? '' : 'none'; b.textContent = rows.length;
}

async function openAgents() {
  enterGlobal(openAgents);
  markActive('__agents__');
  setWall({ id: '__agents__' });
  els.title.textContent = 'Агенты'; els.addrText.textContent = '';
  els.back.style.opacity = '.35';
  els.stage.innerHTML = `<div class="scroll"><div class="dash">
    <div class="dash-h">Агенты — фоновые задачи</div>
    <div class="set-hint">Задачу агенту даёшь со страницы проекта (плитка «Задача агенту»). Агент работает в отдельной ветке
      и НЕ трогает твой код, пока ты не нажмёшь «Принять».</div>
    <div id="aglist"><div class="msg">Читаю…</div></div></div></div>`;
  const tasks = IS_APP ? await API.agentList().catch(() => []) : [];
  const box = document.getElementById('aglist'); if (!box) return;
  if (!tasks.length) { box.innerHTML = '<div class="msg">Задач пока не было.</div>'; return; }
  box.innerHTML = tasks.map(t => {
    const st = AG_ST[t.status] || AG_ST.error;
    const when = new Date(t.started).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<div class="tgroup ag" data-id="${esc(t.id)}">
      <div class="ag-top"><span class="sc-pill ${st.c}">${st.t}</span>
        <b class="ag-proj">${esc(t.projectName || t.projectId)}</b><span class="ag-when">${when}${t.files ? ` · файлов: ${t.files}` : ''}</span></div>
      <div class="ag-prompt">${esc(t.prompt)}</div>
      <div class="ag-body" style="display:none"></div>
      <div class="ag-acts">
        ${t.status === 'done' ? `<span class="board-act" data-a="diff">посмотреть дифф</span>
          <span class="board-act ok" data-a="accept">✓ принять в проект</span>` : ''}
        ${t.status === 'done' || t.status === 'error' ? `<span class="board-act bad" data-a="reject">✕ ${t.status === 'error' ? 'убрать' : 'отклонить'}</span>` : ''}
        ${t.status === 'running' ? `<span class="set-hint">работает ${Math.max(1, Math.round((Date.now() - t.started) / 60000))} мин — придёт уведомление</span>
          <span class="board-act" data-a="explain" title="Спросить у ИИ одной фразой, что агент делает прямо сейчас (лог читать не придётся)">💬 что он делает?</span>` : ''}
        <span class="board-act" data-a="log">лог</span>
      </div></div>`;
  }).join('');
  box.querySelectorAll('.ag').forEach(el => {
    const id = el.dataset.id;
    const body = el.querySelector('.ag-body');
    const show = (html) => { body.style.display = ''; body.innerHTML = html; };
    el.querySelector('[data-a="diff"]')?.addEventListener('click', async () => {
      show('<div class="msg">Читаю дифф…</div>');
      const r = await API.agentDiff(id).catch(e => ({ error: String(e) }));
      show(r.error ? `<div class="msg">${esc(r.error)}</div>` : `<pre class="ag-pre">${esc(r.diff)}</pre>`);
    });
    el.querySelector('[data-a="log"]')?.addEventListener('click', async () => {
      const r = await API.agentLog(id).catch(() => ({ log: '' }));
      show(`<pre class="ag-pre">${esc(r.log || 'пусто')}</pre>`);
    });
    el.querySelector('[data-a="explain"]')?.addEventListener('click', async () => {
      show('<div class="msg"><span class="spin"></span> смотрю, чем он занят…</div>');
      const r = await API.agentExplain(id).catch(e => ({ error: String(e) }));
      show(r && r.answer ? `<div class="ag-explain">💬 ${esc(r.answer.trim())}</div>`
        : `<div class="msg">${esc((r && r.error) || 'не вышло')}</div>`);
    });
    el.querySelector('[data-a="accept"]')?.addEventListener('click', async () => {
      show('<div class="msg">Сливаю в проект…</div>');
      const r = await API.agentAccept(id).catch(e => ({ error: String(e) }));
      if (r.error) show(`<div class="msg">⚠ ${esc(r.error)}</div>`); else openAgents();
    });
    el.querySelector('[data-a="reject"]')?.addEventListener('click', async () => {
      const r = await API.agentReject(id).catch(e => ({ error: String(e) }));
      if (r.error) show(`<div class="msg">⚠ ${esc(r.error)}</div>`); else openAgents();
    });
  });
}

// мини-модал «дать задачу агенту» (window.prompt в Electron не работает)
// prefill — чтобы «поручить агенту» прямо из хвоста подставляло текст задачи (правишь и запускаешь)
function askAgentTask(p, prefill) {
  const root = document.createElement('div');
  root.className = 'palette open';
  root.innerHTML = `<div class="pal-box agm">
      <div class="agm-h">🤖 Задача агенту · ${esc(p.name)}</div>
      <textarea id="agmText" placeholder="Что сделать? Например: «поправь опечатки в README» или «добавь в парсер обработку пустых строк». Агент работает в отдельной ветке — твой код не тронет."></textarea>
      <div class="agm-acts"><button class="foot-btn" data-a="go">Запустить</button><button class="foot-btn" data-a="no">Отмена</button></div>
    </div>`;
  document.body.appendChild(root);
  const ta = root.querySelector('#agmText');
  if (prefill) ta.value = String(prefill);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const close = () => { document.removeEventListener('keydown', onKey, true); root.remove(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); root.querySelector('[data-a="go"]').click(); }
  };
  document.addEventListener('keydown', onKey, true);   // capture: перехватываем раньше палитры
  root.addEventListener('mousedown', e => { if (e.target === root) close(); });
  root.querySelector('[data-a="no"]').addEventListener('click', close);
  root.querySelector('[data-a="go"]').addEventListener('click', async () => {
    const prompt = ta.value.trim(); if (!prompt) return;
    root.querySelector('[data-a="go"]').textContent = 'Запускаю…';
    const r = await API.agentRun(p.id, p.path, prompt).catch(e => ({ error: String(e) }));
    close();
    if (r && r.error) alert('Не получилось: ' + r.error);
    else { void refreshAgentBadge(); openAgents(); }
  });
}

if (IS_APP && API.onAgentUpdate) API.onAgentUpdate(() => {
  void refreshAgentBadge();
  if (document.querySelector('.item.active')?.dataset.id === '__agents__') openAgents();
});
// ночная подтяжка статусов закончилась — если открыт дашборд, показать свежие карточки
if (IS_APP && API.onBulkStatus) API.onBulkStatus(() => {
  if (document.querySelector('.item.active')?.dataset.id === '__home__') openDashboard();
});

// ─────────── глобальный поиск по всем проектам (файлы + содержимое) ───────────
// готовые кросс-проектные вопросы — самая уникальная фича (живой claude по ВСЕМ проектам)
// не должна прятаться за пустым полем; клик по кнопке сразу спрашивает
const ASK_PRESETS = ['Где я застрял?', 'Что поделать сегодня — 3 дела?', 'Что менялось за неделю?', 'Какие хвосты горят?'];
let searchTimer = null;
function openSearch(q) {
  enterGlobal(() => openSearch(document.getElementById('searchIn')?.value || q));
  markActive('__search__');
  setWall({ id: '__search__' });
  els.title.textContent = 'Поиск'; els.addrText.textContent = '';
  els.back.style.opacity = '.35';
  els.stage.innerHTML = `<div class="scroll"><div class="dash">
    <div class="dash-h">Поиск по всем проектам</div>
    <input id="searchIn" class="search-in" type="text" placeholder="Что ищем? (имена файлов и содержимое, все проекты сразу)" spellcheck="false" autocomplete="off" value="${esc(q || '')}"/>
    <div class="ask-row"><span class="set-hint">Не помнишь, где искать? Спроси словами — claude ответит по всем проектам.</span>
      <span class="board-act" data-a="lessons" title="Ищет по решениям и граблям из журналов всех проектов: что ты тогда сделал и где это записано">🔁 как я это уже решал?</span>
      <span class="board-act" data-a="ask">🧠 спросить по всем проектам</span></div>
    <div class="ask-presets">${ASK_PRESETS.map(p => `<span class="ask-chip" data-q="${esc(p)}">${esc(p)}</span>`).join('')}</div>
    <div id="askBox" hidden></div>
    <div id="talksOut"></div>
    <div id="searchOut"><div class="msg">Введи запрос — от 2 символов.</div></div></div></div>`;
  els.stage.querySelector('[data-a="ask"]').addEventListener('click', () => runAsk(document.getElementById('searchIn').value));
  els.stage.querySelector('[data-a="lessons"]').addEventListener('click', () => runAsk(document.getElementById('searchIn').value, true));
  els.stage.querySelectorAll('.ask-chip').forEach(chip => chip.addEventListener('click', () => {
    const q = chip.dataset.q; const inp = document.getElementById('searchIn'); if (inp) inp.value = q; runAsk(q);
  }));
  const inp = document.getElementById('searchIn');
  inp.focus();
  inp.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(inp.value), 350);
  });
  if (q && q.length >= 2) runSearch(q);
}
// поиск по разговорам с ИИ — рядом с файловым поиском: «где мне это объясняли?»
async function runTalksSearch(q) {
  const box = document.getElementById('talksOut'); if (!box) return;
  if (!IS_APP || !API.talksSearch || (q || '').trim().length < 3) { box.innerHTML = ''; return; }
  const rs = await API.talksSearch(q).catch(() => []);
  const cur = document.getElementById('searchIn');
  if (!box.isConnected || (cur && cur.value.trim() !== q.trim())) return;   // устарело — не рисуем
  if (!rs.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="tgroup sr"><div class="tgname">💬 В разговорах с ИИ · ${rs.length}</div>
    ${rs.map(r => `<div class="titem talk">
      <span class="talk-proj" style="color:${r.color}">${esc(r.project)}</span>
      <span class="talk-who">${esc(r.role)}</span>
      <span class="talk-date">${r.at ? new Date(r.at).toLocaleDateString('ru-RU') : ''}</span>
      <div class="talk-snip">${esc(r.snippet)}</div></div>`).join('')}</div>`;
}
async function runSearch(q) {
  const box = document.getElementById('searchOut'); if (!box) return;
  q = (q || '').trim();
  if (q.length < 2) { box.innerHTML = '<div class="msg">Введи запрос — от 2 символов.</div>'; document.getElementById('talksOut').innerHTML = ''; return; }
  box.innerHTML = '<div class="msg">Ищу…</div>';
  void runTalksSearch(q);   // разговоры ищем параллельно файлам — они медленнее, не задерживаем
  const rs = IS_APP ? await API.searchAll(q).catch(() => []) : [];
  if (!document.getElementById('searchIn') || document.getElementById('searchIn').value.trim() !== q) return; // устарело
  if (!rs.length) { box.innerHTML = '<div class="msg">Ничего не нашлось.</div>'; return; }
  box.innerHTML = rs.map(r => `<div class="tgroup sr" data-id="${esc(r.id)}">
      <div class="tgname" data-open="1"><span class="tgdot" style="background:${r.color}"></span>${esc(r.name)}</div>
      ${r.names.map(f => `<div class="titem sr-hit" data-file="${esc(f)}">📄 ${esc(f)}</div>`).join('')}
      ${r.content.map(h => `<div class="titem sr-hit" data-file="${esc(h.file)}"><code>${esc(h.file)}:${h.line}</code> ${esc(h.text)}</div>`).join('')}
    </div>`).join('');
  box.querySelectorAll('.sr').forEach(el => {
    const proj = () => allProjects().find(x => x.id === el.dataset.id);
    el.querySelector('[data-open="1"]')?.addEventListener('click', () => { const p = proj(); if (p) openProject(p); });
    el.querySelectorAll('.sr-hit').forEach(hit => hit.addEventListener('click', () => {
      const p = proj(); if (!p) return;
      openProject(p);
      pushView({ kind: 'file', path: joinPath(p.path, hit.dataset.file.replace(/\//g, p.path.includes('\\') ? '\\' : '/')) });
      selectTab('overview');   // у борд-проектов первая вкладка не «Обзор» — иначе клик выглядел мёртвым
    }));
  });
}

// спросить словами по всем проектам сразу (claude отвечает по выжимкам + найденному в файлах)
let askSeq = 0;
// lessons=true → режим «память граблей»: ищет по решениям/урокам из журналов, а не по всему подряд
async function runAsk(q, lessons) {
  q = (q || '').trim();
  const box = document.getElementById('askBox'); if (!box) return;
  if (q.length < 3) {
    box.hidden = false;
    box.innerHTML = `<div class="tgroup"><div class="msg">${lessons
      ? 'Напиши, что вспомнить — например «как настраивал VPN?» или «где чинил авто-пуш?»'
      : 'Напиши вопрос словами — например «что осталось по боту?»'}</div></div>`;
    return;
  }
  const my = ++askSeq;   // токен против устаревшего ответа: пока claude думает, могли спросить другое
  box.hidden = false;
  box.innerHTML = `<div class="tgroup ask-card"><div class="ask-q">${lessons ? '🔁 ' : ''}${esc(q)}</div>
    <div class="ask-a"><span class="spin"></span> ${lessons ? 'вспоминаю, как ты это решал…' : 'смотрю все проекты…'} (это занимает до 3 минут)</div></div>`;
  const r = await (lessons ? API.lessonsAsk(q) : API.askAll(q)).catch(e => ({ error: String((e && e.message) || e) }));
  if (my !== askSeq) return;   // пришёл ответ на старый вопрос — не показываем
  const el = box.querySelector('.ask-a'); if (!el) return;
  // ответ приходит с лёгким markdown — оформляем тем же inline(), что и карточки (он экранирует)
  el.innerHTML = r && r.answer
    ? r.answer.split('\n').map(line => {
        const t = line.trim();
        if (!t) return '';
        if (/^[-*•]\s/.test(t)) return `<div class="sc-li">${inline(t.replace(/^[-*•]\s/, ''))}</div>`;
        return `<p style="margin:6px 0">${inline(t)}</p>`;
      }).join('')
    : `⚠ ${esc((r && r.error) || 'не получилось')}`;
  if (r && r.answer) {
    const copy = document.createElement('div');
    copy.className = 'ask-copy'; copy.textContent = '⧉ скопировать ответ';
    copy.addEventListener('click', () => {
      if (IS_APP) API.copyPath(r.answer); else navigator.clipboard.writeText(r.answer).catch(() => {});
      copy.textContent = '✓ скопировано'; setTimeout(() => { copy.textContent = '⧉ скопировать ответ'; }, 1200);
    });
    el.appendChild(copy);
  }
}

// ─────────── расход токенов по проектам ───────────
function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн';
  if (n >= 1e3) return Math.round(n / 1e3) + ' тыс';
  return String(n);
}
async function openUsage() {
  enterGlobal(openUsage);
  markActive('__usage__');
  setWall({ id: '__usage__' });
  els.title.textContent = 'Расход'; els.addrText.textContent = '';
  els.back.style.opacity = '.35';
  els.stage.innerHTML = `<div class="scroll"><div class="dash">
    <div class="dash-h">Расход токенов по проектам</div>
    <div class="set-hint">Сколько «сказал» Claude в каждом проекте (выходные токены из локальных транскриптов).
      Показывает, куда уходит лимит подписки. Обновляется раз в 10 минут.</div>
    <div id="usageOut"><div class="msg">Считаю (первый раз может занять полминуты)…</div></div></div></div>`;
  const rows = IS_APP ? await API.usageStats().catch(() => []) : [];
  const box = document.getElementById('usageOut'); if (!box) return;
  if (!rows.length) { box.innerHTML = '<div class="msg">Данных нет — транскрипты claude не найдены.</div>'; return; }
  const max = Math.max(...rows.map(r => r.t30), 1);
  const total7 = rows.reduce((s, r) => s + r.t7, 0), total30 = rows.reduce((s, r) => s + r.t30, 0);
  box.innerHTML = `<div class="tgroup">
    <div class="u-total">за 7 дней: <b>${fmtTok(total7)}</b> · за 30 дней: <b>${fmtTok(total30)}</b> токенов</div>
    ${rows.map(r => `<div class="u-row" data-id="${esc(r.id)}">
      <span class="u-name">${esc(r.name)}</span>
      <span class="u-bar"><span class="u-fill" style="width:${Math.max(2, Math.round(r.t30 / max * 100))}%;background:${r.color}"></span></span>
      <span class="u-num">${fmtTok(r.t7)} / ${fmtTok(r.t30)}</span></div>`).join('')}
    <div class="set-hint" style="margin-top:10px">числа: за 7 дней / за 30 дней</div></div>`;
  box.querySelectorAll('.u-row').forEach(el => el.addEventListener('click', () => {
    const p = allProjects().find(x => x.id === el.dataset.id); if (p) openProject(p);
  }));
}

// ─────────── палитра команд (Ctrl+K / Cmd+K) ───────────
const pal = {
  root: document.getElementById('palette'),
  input: document.getElementById('palInput'),
  list: document.getElementById('palList'),
  items: [], sel: 0,
};

function palCommands() {
  const cmds = [
    { icon: '⌂', name: 'Обзор проектов', hint: 'экран', run: openDashboard },
    { icon: '✓', name: 'Хвосты', hint: 'экран', run: openTails },
    { icon: '🤖', name: 'Агенты', hint: 'экран', run: openAgents },
    { icon: '🔍', name: 'Поиск по всем проектам', hint: 'экран', run: () => openSearch('') },
    { icon: '🧠', name: 'Спросить по всем проектам', hint: 'claude', run: () => { openSearch(''); setTimeout(() => runAsk(''), 60); } },
    { icon: '◔', name: 'Расход токенов', hint: 'экран', run: openUsage },
    { icon: '⌗', name: 'Терминалы (стена)', hint: 'экран', run: openTerminalGrid },
    { icon: '🔄', name: 'Синхра', hint: 'экран', run: openSync },
    { icon: '↺', name: 'Что я сделал', hint: 'вчера / неделя, все проекты', run: () => openDid() },
    { icon: '🔗', name: 'Карта связей', hint: 'что на каком сервере висит', run: openLinksMap },
    { icon: '⚙', name: 'Настройки', hint: 'экран', run: openSettings },
    { icon: '✎', name: 'Заметки', hint: 'панель', run: () => els.notesBtn.click() },
  ];
  for (const p of allProjects()) {
    cmds.push({ icon: '·', av: wallFor(p), name: p.name, hint: 'проект', run: () => openProject(p) });
    cmds.push({ icon: '❯', name: p.name + ' — терминал', hint: 'терминал', run: () => { openProject(p); selectTab('term'); } });
  }
  return cmds;
}

function palOpen() {
  pal.root.classList.add('open');
  pal.input.value = ''; palFilter('');
  pal.input.focus();
}
function palClose() { pal.root.classList.remove('open'); pal.input.blur(); }

function palFilter(q) {
  q = (q || '').trim().toLowerCase();
  pal.items = palCommands().filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 12);
  pal.sel = 0;
  palRender();
}
function palRender() {
  pal.list.innerHTML = pal.items.map((c, i) => `<div class="pal-item${i === pal.sel ? ' sel' : ''}" data-i="${i}">
      ${c.av ? `<span class="pal-av" style="background-image:url('${c.av}')"></span>` : `<span class="pal-ic">${c.icon}</span>`}
      <span class="pal-name">${esc(c.name)}</span><span class="pal-hint">${esc(c.hint)}</span></div>`).join('')
    || `<div class="pal-empty">ничего не нашлось</div>`;
  pal.list.querySelectorAll('.pal-item').forEach(el => {
    el.addEventListener('click', () => palRun(Number(el.dataset.i)));
    // перерисовывать ТОЛЬКО при смене выбора: иначе узел под курсором пересоздаётся между
    // нажатием и отпусканием мыши и клик теряется
    el.addEventListener('mousemove', () => {
      const i = Number(el.dataset.i);
      if (pal.sel !== i) { pal.sel = i; palRender(); }
    });
  });
}
function palRun(i) {
  const c = pal.items[i]; if (!c) return;
  palClose();
  try { c.run(); } catch (e) { console.error(e); }
}

pal.input.addEventListener('input', () => palFilter(pal.input.value));
pal.input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.sel = Math.min(pal.sel + 1, pal.items.length - 1); palRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.sel = Math.max(pal.sel - 1, 0); palRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); palRun(pal.sel); }
  else if (e.key === 'Escape') { palClose(); }
});
pal.root.addEventListener('mousedown', e => { if (e.target === pal.root) palClose(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('modalBack')) { closeModal(); return; }
  if (e.key === 'Escape' && els.notes.classList.contains('open')) {
    els.notes.classList.remove('open'); els.notesBtn.classList.remove('on'); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л')) {
    e.preventDefault();
    pal.root.classList.contains('open') ? palClose() : palOpen();
  } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyF') {
    e.preventDefault(); openSearch('');
  } else if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && e.target === document.body)) {
    e.preventDefault(); back();      // рефлекс из браузера: Alt+← = назад
  } else if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault(); fwd();
  } else if (e.key === 'Escape' && pal.root.classList.contains('open')) palClose();
});
// боковые кнопки мыши (назад/вперёд), как в браузере
window.addEventListener('mouseup', e => {
  if (e.button === 3) { e.preventDefault(); back(); }
  else if (e.button === 4) { e.preventDefault(); fwd(); }
});

// ─────────── команды из меню приложения (мак: Cmd+1..9 / Cmd+T / Cmd+D) ───────────
if (IS_APP && API.onAppCmd) {
  API.onAppCmd(({ action, arg }) => {
    if (action === 'project') {
      const p = allProjects()[arg - 1];
      if (p) openProject(p);
    } else if (action === 'terminal') {
      if (current) selectTab('term');
      else { const p = allProjects()[0]; if (p) { openProject(p); selectTab('term'); } }
    } else if (action === 'dashboard') openDashboard();
    else if (action === 'sync-push') { openSync(); setTimeout(openSyncPush, 120); }   // из меню в трее
    else if (action === 'agents') openAgents();
    // из main: ловятся даже когда фокус в терминале-webview (там окно клавиш не видит)
    else if (action === 'palette') { pal.root.classList.contains('open') ? palClose() : palOpen(); }
    else if (action === 'search') openSearch('');
  });
}

// ─────────── старт ───────────
async function init() {
  if (IS_APP) {
    try {
      const [pr, walls, gr] = await Promise.all([
        API.listProjects(), API.wallList().catch(() => ({})), API.groupList().catch(() => null),
      ]);
      projects = pr; customWalls = walls || {};
      if (Array.isArray(gr) && gr.length) navGroups = gr;
    } catch (e) { console.error(e); }
  } else {
    projects = { work: [{ id: 'demo', name: 'Демо', color: '#c6a568', path: '' }], base: [] };
  }
  renderNav();
  void loadNotes();   // панель заметок скрыта — не блокируем старт её чтением
  void openDashboard();   // стартовый экран — обзор всех проектов (+ кнопка «Продолжить»)
  void autoSync(false);   // авто-подтяжка свежего с сервера при запуске (фоном, не блокирует UI)
}

// Вернулся в окно (переключился с другого устройства / из фона) → тихо подтянуть свежее.
// Дебаунс 25с, чтобы не дёргать pull на каждый клик по окну.
window.addEventListener('focus', () => {
  if (IS_APP && Date.now() - lastPullTs > 25000) void autoSync(false);
});

init();
