// ШТАБ · телефон — тот же кокпит с дивана. Всё через /api/*, терминал — через прокси /term/.
const $ = (s) => document.querySelector(s);
const screen = $('#screen'), ttl = $('#ttl'), backBtn = $('#backBtn');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (p, opts) => {
  const r = await fetch(p, { credentials: 'same-origin', ...opts });
  if (!r.ok) throw new Error(await r.text().catch(() => r.status));
  return r.json();
};
const HEALTH = { ok: { c: 'ok', t: 'идёт' }, slow: { c: 'slow', t: 'тихо' }, stuck: { c: 'stuck', t: 'затык' } };
const WALLS = ['aurora-forest', 'purple-night', 'ocean-sunset', 'aurora-snow', 'canyon-stars', 'nebula',
  'foggy-mountains', 'starfield', 'milkyway-peaks', 'purple-galaxy', 'milkyway-figure', 'forest-dusk', 'misty-forest'];
const hash = (s) => { let h = 0; s = s || ''; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const wallFor = (p) => `/wall/${WALLS[hash(p.id || p.name) % WALLS.length]}.jpg`;

let projects = [], tab = 'projects', stack = [];

// ─────────── навигация ───────────
function setTop(title, canBack) {
  ttl.textContent = title;
  backBtn.hidden = !canBack;
}
backBtn.onclick = () => { stack.pop(); const prev = stack.pop(); prev ? prev() : show(tab); };
function push(fn) { stack.push(fn); fn(); }

document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
  tab = b.dataset.t; stack = []; show(tab);
});

function show(t) {
  screen.classList.remove('flush');
  if (t === 'projects') return viewProjects();
  if (t === 'tails') return viewTails();
  if (t === 'agents') return viewAgents();
  if (t === 'notes') return viewNotes();
}

// ─────────── проекты ───────────
async function viewProjects() {
  setTop('Проекты', false);
  screen.innerHTML = '<div class="msg"><span class="spin"></span>читаю…</div>';
  try {
    const groups = await api('/api/projects');
    projects = Object.values(groups || {}).flat();   // разделы приходят из профиля
  } catch (e) { screen.innerHTML = `<div class="msg">Не дозвонился до компа.<br>${esc(e.message)}</div>`; return; }
  screen.innerHTML = projects.map(p => `<button class="card" data-id="${esc(p.id)}">
      <div class="thumb" style="background-image:url('${wallFor(p)}')"></div>
      <div class="cbody"><div class="crow"><span class="pill off" data-h>—</span><span class="cname">${esc(p.name)}</span></div>
        <div class="pulse" data-p>…</div></div></button>`).join('');
  screen.querySelectorAll('.card').forEach(el => el.onclick = () => {
    const p = projects.find(x => x.id === el.dataset.id); if (p) push(() => viewProject(p));
  });
  // статусы — по мере готовности
  projects.forEach(async (p) => {
    try {
      const m = await api(`/api/status?id=${encodeURIComponent(p.id)}&dir=${encodeURIComponent(p.path)}`);
      const el = screen.querySelector(`.card[data-id="${CSS.escape(p.id)}"]`); if (!el) return;
      const st = m && m.data, h = st ? (HEALTH[st.health] || HEALTH.slow) : { c: 'off', t: '—' };
      const pill = el.querySelector('[data-h]'); pill.className = 'pill ' + h.c; pill.textContent = h.t;
      el.querySelector('[data-p]').textContent = st ? (st.pulse || '') : 'нет выжимки';
    } catch (_) {}
  });
}

async function viewProject(p) {
  setTop(p.name, true);
  screen.classList.remove('flush');
  screen.innerHTML = '<div class="msg"><span class="spin"></span>открываю…</div>';
  let st = null;
  try { const m = await api(`/api/status?id=${encodeURIComponent(p.id)}&dir=${encodeURIComponent(p.path)}`); st = m && m.data; } catch (_) {}
  const h = st ? (HEALTH[st.health] || HEALTH.slow) : { c: 'off', t: '—' };
  const list = (arr, cls) => (arr || []).map(x => `<div class="item ${cls || ''}">${esc(x)}</div>`).join('');
  screen.innerHTML = `
    <div class="hero">
      <div class="crow"><span class="pill ${h.c}">${h.t}</span></div>
      ${st ? `<div class="pulse">${esc(st.pulse || '')}</div>` : '<div class="pulse">Выжимки пока нет.</div>'}
    </div>
    <div class="acts">
      <button class="btn" data-a="term">❯ Терминал</button>
      <button class="btn ghost" data-a="agent">🤖 Задача агенту</button>
    </div>
    ${st && st.done && st.done.length ? `<div class="sec">Сделали</div><div class="group">${list(st.done)}</div>` : ''}
    ${st && (st.next || []).length || st && (st.waiting || []).length ?
      `<div class="sec">Дальше</div><div class="group">${list(st && st.next)}${list(st && st.waiting, 'wait')}</div>` : ''}`;
  screen.querySelector('[data-a="term"]').onclick = () => push(() => viewTerm(p));
  screen.querySelector('[data-a="agent"]').onclick = () => askAgent(p);
}

// ─────────── терминал (через прокси на сайдкар) ───────────
function viewTerm(p) {
  setTop('❯ ' + p.name, true);
  screen.classList.add('flush');
  screen.innerHTML = `<div class="termwrap"><iframe src="/term/?cwd=${encodeURIComponent(p.path)}" allow="clipboard-read; clipboard-write"></iframe></div>`;
}

// ─────────── хвосты ───────────
async function viewTails() {
  setTop('Хвосты', false);
  screen.innerHTML = '<div class="msg"><span class="spin"></span>собираю…</div>';
  let rows = [];
  try { rows = await api('/api/tails'); } catch (e) { screen.innerHTML = `<div class="msg">${esc(e.message)}</div>`; return; }
  if (!rows.length) { screen.innerHTML = '<div class="msg">Хвостов нет — везде чисто ✓</div>'; return; }
  screen.innerHTML = rows.map(r => `<div class="group">
      <div class="gname"><span class="gdot" style="background:${r.color}"></span>${esc(r.name)}</div>
      ${(r.next || []).map(x => `<div class="item">${esc(x)}</div>`).join('')}
      ${(r.waiting || []).map(x => `<div class="item wait">⏳ ${esc(x)}</div>`).join('')}
    </div>`).join('');
}

// ─────────── агенты ───────────
const AG = { running: { c: 'slow', t: 'работает' }, done: { c: 'ok', t: 'готово' },
  error: { c: 'stuck', t: 'ошибка' }, accepted: { c: 'ok', t: 'принято' }, rejected: { c: 'off', t: 'отклонено' } };
async function viewAgents() {
  setTop('Агенты', false);
  screen.innerHTML = '<div class="msg"><span class="spin"></span>читаю…</div>';
  let tasks = [];
  try { tasks = await api('/api/agents'); } catch (e) { screen.innerHTML = `<div class="msg">${esc(e.message)}</div>`; return; }
  if (!tasks.length) { screen.innerHTML = '<div class="msg">Задач пока не было.<br>Дай задачу со страницы проекта.</div>'; return; }
  screen.innerHTML = tasks.map(t => {
    const s = AG[t.status] || AG.error;
    return `<div class="ag" data-id="${esc(t.id)}">
      <div class="crow"><span class="pill ${s.c}">${s.t}</span><b>${esc(t.projectName || t.projectId)}</b></div>
      <div class="ag-p">${esc(t.prompt)}</div>
      <div class="out" hidden></div>
      <div class="ag-acts">
        ${t.status === 'done' ? '<button class="mini" data-a="diff">дифф</button><button class="mini ok" data-a="accept">✓ принять</button>' : ''}
        ${t.status === 'done' || t.status === 'error' ? '<button class="mini bad" data-a="reject">✕ убрать</button>' : ''}
      </div></div>`;
  }).join('');
  screen.querySelectorAll('.ag').forEach(el => {
    const id = el.dataset.id, out = el.querySelector('.out');
    const put = (h) => { out.hidden = false; out.innerHTML = h; };
    const btn = (a, fn) => { const b = el.querySelector(`[data-a="${a}"]`); if (b) b.onclick = fn; };
    btn('diff', async () => { put('<span class="spin"></span>'); const r = await api('/api/agent/diff?id=' + id); put(`<pre class="pre">${esc(r.diff || r.error)}</pre>`); });
    btn('accept', async () => {
      put('<span class="spin"></span>сливаю…');
      const r = await api('/api/agent/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      r.error ? put('⚠ ' + esc(r.error)) : viewAgents();
    });
    btn('reject', async () => {
      await api('/api/agent/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      viewAgents();
    });
  });
  refreshAgentDot(tasks);
}
function refreshAgentDot(tasks) {
  const hot = (tasks || []).filter(t => t.status === 'running' || t.status === 'done').length;
  $('#agDot').hidden = !hot;
}
setInterval(async () => {
  try { const t = await api('/api/agents'); refreshAgentDot(t); if (tab === 'agents' && !stack.length) viewAgents(); } catch (_) {}
}, 20000);

function askAgent(p) {
  const sheet = $('#askSheet'), h = sheet.querySelector('.sheet-h'), ta = $('#askText'), out = $('#askOut');
  h.textContent = '🤖 Задача агенту · ' + p.name;
  ta.placeholder = 'Что сделать? Агент работает в отдельной ветке — твой код не тронет.';
  ta.value = ''; out.hidden = true; sheet.hidden = false; ta.focus();
  $('#askGo').textContent = 'Запустить';
  $('#askGo').onclick = async () => {
    const prompt = ta.value.trim(); if (!prompt) return;
    $('#askGo').textContent = 'Запускаю…';
    const r = await api('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, dir: p.path, prompt }) }).catch(e => ({ error: String(e.message) }));
    sheet.hidden = true;
    if (r.error) alert('Не получилось: ' + r.error);
    else { tab = 'agents'; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.dataset.t === 'agents')); stack = []; viewAgents(); }
  };
}

// ─────────── заметки ───────────
let notesT = null;
async function viewNotes() {
  setTop('Заметки', false);
  screen.innerHTML = '<div class="msg"><span class="spin"></span></div>';
  let text = '';
  try { text = (await api('/api/notes')).text || ''; } catch (_) {}
  screen.innerHTML = `<textarea class="notes-ta" id="nta" placeholder="Мысли по проектам — те же, что на компе"></textarea>
    <div class="saved" id="nsav">едет на комп автоматически</div>`;
  const ta = $('#nta'); ta.value = text;
  ta.oninput = () => {
    $('#nsav').textContent = '…';
    clearTimeout(notesT);
    notesT = setTimeout(async () => {
      try {
        await api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ta.value }) });
        $('#nsav').textContent = 'сохранено на компе';
      } catch (_) { $('#nsav').textContent = '⚠ не сохранилось'; }
    }, 700);
  };
}

// ─────────── спросить по всем проектам ───────────
$('#askBtn').onclick = () => {
  const sheet = $('#askSheet');
  sheet.querySelector('.sheet-h').textContent = 'Спросить по всем проектам';
  $('#askText').placeholder = 'Например: где у меня было про парсер цен? что осталось по боту?';
  $('#askText').value = ''; $('#askOut').hidden = true; sheet.hidden = false; $('#askText').focus();
  $('#askGo').textContent = 'Спросить';
  $('#askGo').onclick = async () => {
    const q = $('#askText').value.trim(); if (!q) return;
    const out = $('#askOut');
    out.hidden = false; out.innerHTML = '<span class="spin"></span>думаю по всем проектам…';
    try {
      const r = await api('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) });
      out.textContent = r.answer || r.error || 'пусто';
    } catch (e) { out.textContent = 'не получилось: ' + e.message; }
  };
};
$('#askNo').onclick = () => { $('#askSheet').hidden = true; };
$('#askSheet').onclick = (e) => { if (e.target === $('#askSheet')) $('#askSheet').hidden = true; };

show('projects');
