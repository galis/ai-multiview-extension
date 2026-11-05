// 并排页：布局、增删栏、拖宽、拖动排序、广播。
const EXT_ORIGIN = location.origin;
const SITES = self.AIMV_SITES;
const DEFAULT_IDS = ['claude', 'chatgpt', 'gemini', 'deepseek', 'doubao', 'qwen', 'kimi', 'yuanbao'];
const $ = s => document.querySelector(s);

let state = null;              // { panes:[{id,siteId,name,url,on,w}], layout, mode, lazy }
const live = new Map();        // paneId -> { iframe, badge, loaded, ready, readyTimer }
const pending = new Map();     // reqId -> resolve
let registered = false;

// 每栏的反色：auto = 页面底色和主题不一致才反色；on = 一直反色；off = 不动
const INVERT_NEXT = { auto: 'on', on: 'off', off: 'auto' };
const INVERT_LABEL = { auto: '◐', on: '🌗', off: '○' };
const INVERT_TITLE = { auto: '颜色：自动（页面底色和主题不一致时反色）', on: '颜色：一直反色', off: '颜色：不处理，保持网站原样' };
const invertOf = p => p.invert || (p.dark === true ? 'on' : p.dark === false ? 'off' : 'auto');
const mql = matchMedia('(prefers-color-scheme: dark)');
const themeTarget = () => (state.theme === 'light' || state.theme === 'dark') ? state.theme : (mql.matches ? 'dark' : 'light');
function applyTheme() {
  document.documentElement.dataset.theme = themeTarget();
  $('#theme').value = state.theme || 'system';
}
const uid = () => Math.random().toString(36).slice(2, 9);
const siteById = id => SITES.find(s => s.id === id);
const mkPane = s => ({ id: uid(), siteId: s.id, name: s.name, url: s.url, on: true, w: 1 });
const defaults = () => ({ panes: DEFAULT_IDS.map(id => mkPane(siteById(id))), layout: 'grid', mode: 'iframe', lazy: false, knownDefaults: DEFAULT_IDS.slice() });

async function load() {
  const { aimv } = await chrome.storage.local.get('aimv');
  state = aimv && aimv.panes ? aimv : defaults();
  // 新版本加了默认站点（例如元宝）时，追加到老用户的布局里；用户删掉过的不再加回
  const known = state.knownDefaults || ['claude', 'chatgpt', 'gemini', 'deepseek', 'doubao', 'qwen', 'kimi'];
  for (const id of DEFAULT_IDS) if (!known.includes(id)) state.panes.push(mkPane(siteById(id)));
  state.knownDefaults = DEFAULT_IDS.slice();
  await chrome.storage.local.set({ aimv: state });
}
const save = () => chrome.storage.local.set({ aimv: state });

function log(t) {
  const d = document.createElement('div');
  d.textContent = new Date().toLocaleTimeString() + ' ' + t;
  $('#log').prepend(d);
}

function setBadge(id, text, cls = '') {
  const l = live.get(id);
  if (!l) return;
  l.badge.textContent = text;
  l.badge.className = 'badge ' + cls;
  l.badge.title = text;
}

// ---------- 渲染 ----------
const paneEls = new Map();     // paneId -> <section>

function resetPanes() {
  for (const l of live.values()) clearTimeout(l.readyTimer);
  live.clear(); paneEls.clear();
  $('#panes').innerHTML = '';
}

function render() {
  document.body.className = `layout-${state.layout} mode-${state.mode}`;
  $('#layout').value = state.layout;
  $('#mode').value = state.mode;
  $('#lazy').checked = state.lazy;
  $('#think').checked = !!state.think;
  $('#serial').checked = !!state.serial;

  const host = $('#panes');
  if (state.layout === 'grid') {
    const n = state.panes.length;
    const rows = n > 3 ? 2 : 1;
    host.style.gridTemplateColumns = `repeat(${Math.ceil(n / rows)}, minmax(0, 1fr))`;
    host.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  } else {
    host.style.gridTemplateColumns = host.style.gridTemplateRows = '';
  }

  host.querySelectorAll('.splitter').forEach(s => s.remove());
  const ids = new Set(state.panes.map(p => p.id));
  for (const [id, el] of paneEls) if (!ids.has(id)) {
    el.remove(); paneEls.delete(id);
    clearTimeout(live.get(id)?.readyTimer); live.delete(id);
  }
  // 按顺序摆放；已有的栏用 moveBefore 挪位置（Chrome 133+ 不会重载 iframe）
  let cursor = host.firstElementChild;
  state.panes.forEach((p, i) => {
    let el = paneEls.get(p.id);
    if (!el) { el = makePane(p); paneEls.set(p.id, el); }
    el.style.flex = `${p.w} 1 0`;
    if (cursor === el) cursor = el.nextElementSibling;
    else if (el.isConnected && host.moveBefore) host.moveBefore(el, cursor);
    else host.insertBefore(el, cursor);
    if (i > 0) host.insertBefore(makeSplitter(i), el);
  });
}

function makePane(p) {
  const el = document.createElement('section');
  el.className = 'pane';
  el.dataset.id = p.id;

  const head = document.createElement('div');
  head.className = 'pane-head';
  head.draggable = true;
  head.innerHTML = `
    <input type="checkbox" class="on" title="广播时发给这一栏">
    <span class="name"></span>
    <span class="badge">未加载</span>
    <span class="grow"></span>
    <button class="invert"></button>
    <button class="reload" title="刷新">↻</button>
    <button class="open" title="在新标签页打开（登录请在这里做）">↗</button>
    <button class="remove" title="删掉这一栏">✕</button>`;
  head.querySelector('.name').textContent = p.name;
  head.querySelector('.name').title = p.url;
  const cb = head.querySelector('.on');
  cb.checked = p.on;
  cb.onchange = () => { p.on = cb.checked; save(); };
  const invBtn = head.querySelector('.invert');
  const paintInv = () => { invBtn.textContent = INVERT_LABEL[invertOf(p)]; invBtn.title = INVERT_TITLE[invertOf(p)] + '（点击切换）'; };
  paintInv();
  invBtn.onclick = () => { p.invert = INVERT_NEXT[invertOf(p)]; delete p.dark; save(); paintInv(); applyPane(p, false); };
  head.querySelector('.open').onclick = () => window.open(p.url, '_blank');
  head.querySelector('.remove').onclick = () => {
    state.panes = state.panes.filter(x => x.id !== p.id);
    save(); render();
  };
  head.querySelector('.reload').onclick = () => {
    const l = live.get(p.id);
    if (state.mode === 'iframe' && l && l.iframe) { l.ready = false; l.iframe.src = p.url; setBadge(p.id, '加载中'); watchReady(p.id); }
  };
  wireReorder(head, el, p);
  el.appendChild(head);

  const badge = head.querySelector('.badge');
  const l = { iframe: null, badge, loaded: false, ready: false, readyTimer: null };
  live.set(p.id, l);

  if (state.mode === 'window') {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = '多窗口模式：这一栏在独立窗口里。点上方「平铺成窗口」打开。';
    el.appendChild(ph);
    badge.textContent = '窗口';
    return el;
  }

  if (state.lazy) {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    const b = document.createElement('button');
    b.textContent = '加载 ' + p.name;
    b.onclick = () => { ph.remove(); attachIframe(el, p); };
    ph.appendChild(b);
    el.appendChild(ph);
  } else {
    attachIframe(el, p);
  }
  return el;
}

function attachIframe(el, p) {
  const l = live.get(p.id);
  const f = document.createElement('iframe');
  f.allow = 'clipboard-read; clipboard-write; microphone; fullscreen';
  f.src = p.url;
  el.appendChild(f);
  l.iframe = f;
  l.loaded = true;
  setBadge(p.id, '加载中', '');
  watchReady(p.id);
}

function watchReady(id) {
  const l = live.get(id);
  clearTimeout(l.readyTimer);
  l.readyTimer = setTimeout(() => {
    if (!l.ready) setBadge(id, '没响应：可能被拦或在验证页', 'bad');
  }, 20000);
}

// ---------- 拖宽 ----------
function makeSplitter(i) {
  const s = document.createElement('div');
  s.className = 'splitter';
  s.onpointerdown = ev => {
    if (state.layout !== 'columns') return;
    ev.preventDefault();
    const a = state.panes[i - 1], b = state.panes[i];
    const elA = document.querySelector(`.pane[data-id="${a.id}"]`), elB = document.querySelector(`.pane[data-id="${b.id}"]`);
    const wa = elA.getBoundingClientRect().width, wb = elB.getBoundingClientRect().width;
    const sum = a.w + b.w, x0 = ev.clientX;
    document.body.classList.add('dragging');
    s.classList.add('active');
    const move = e => {
      const na = Math.max(240, Math.min(wa + wb - 240, wa + e.clientX - x0));
      a.w = sum * na / (wa + wb);
      b.w = sum - a.w;
      elA.style.flex = `${a.w} 1 0`;
      elB.style.flex = `${b.w} 1 0`;
    };
    const up = () => {
      document.body.classList.remove('dragging');
      s.classList.remove('active');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      save();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  return s;
}

// ---------- 拖动排序（拖栏头放到另一栏上） ----------
let dragId = null;
function wireReorder(head, el, p) {
  head.ondragstart = e => { dragId = p.id; e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('reordering'); };
  head.ondragend = () => { dragId = null; document.body.classList.remove('reordering'); document.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target')); };
  el.ondragover = e => { if (dragId && dragId !== p.id) { e.preventDefault(); el.classList.add('drop-target'); } };
  el.ondragleave = () => el.classList.remove('drop-target');
  el.ondrop = e => {
    e.preventDefault();
    if (!dragId || dragId === p.id) return;
    const from = state.panes.findIndex(x => x.id === dragId), to = state.panes.findIndex(x => x.id === p.id);
    const [m] = state.panes.splice(from, 1);
    state.panes.splice(to, 0, m);
    save(); render();
  };
}

// ---------- 和 iframe 里的 content script 通信 ----------
addEventListener('message', ev => {
  if (!ev.data || typeof ev.data !== 'object') return;
  const id = [...live].find(([, l]) => l.iframe && l.iframe.contentWindow === ev.source)?.[0];
  if (!id) return;
  if (ev.data.aimv === 'ready') {
    const l = live.get(id);
    const first = !l.ready;
    l.ready = true;
    clearTimeout(l.readyTimer);
    if (first) setBadge(id, l.badge.textContent === '开新对话中…' ? '已开新对话' : '就绪', 'ok');   // SPA 换页时也会再报一次，别盖掉发送结果
    const p = state.panes.find(x => x.id === id);
    if (p) applyPane(p, first);
  } else if (ev.data.aimv === 'res') {
    const r = pending.get(ev.data.reqId);
    if (r) { pending.delete(ev.data.reqId); r(ev.data.res); }
  }
});

function askFrame(id, cmd, timeout = 12000, noFocus = false) {
  const l = live.get(id);
  if (!l || !l.iframe) return Promise.resolve({ ok: false, err: '没加载' });
  if (!l.ready) return Promise.resolve({ ok: false, err: '页面没就绪（未登录 / 被拦 / 验证页）' });
  const reqId = uid();
  return new Promise(resolve => {
    pending.set(reqId, resolve);
    setTimeout(() => { if (pending.delete(reqId)) resolve({ ok: false, err: '超时没回应' }); }, timeout);
    if (!noFocus && cmd.cmd !== 'theme') l.iframe.focus();
    l.iframe.contentWindow.postMessage({ aimv: 'cmd', reqId, ...cmd }, '*');
  });
}

async function ask(id, cmd, noFocus) {
  if (state.mode === 'window') return chrome.runtime.sendMessage({ type: 'sendToWindow', paneId: id, cmd: { aimv: 'cmd', ...cmd }, noFocus });
  return askFrame(id, cmd, 12000, noFocus);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 广播分两步：
//  1) 依次填字：往输入框插字要焦点在那个框里，一次只能一个框有焦点，所以只能一个个来（每栏约 0.3 秒）；
//  2) 同时点发送：点按钮不需要焦点，所有栏一起点，几乎同一时刻发出去。
// 「依次发送」打勾时退回老办法：每栏填完立刻发，发完再下一栏。
async function broadcast(send) {
  const text = $('#prompt').value.trim();
  if (!text) return;
  if (text === '/clear') { $('#prompt').value = ''; return clearAll(); }
  const targets = state.panes.filter(p => p.on);
  const t0 = performance.now();
  log(`${send ? '发送' : '填入'}到 ${targets.length} 栏${send && !state.serial ? '（先填字，再同时发送）' : ''}`);
  const results = {};
  const report = (p, r) => {
    results[p.name] = r;
    if (r.ok) setBadge(p.id, r.step === 'sent' ? '已发送' : '已填入', 'ok');
    else setBadge(p.id, r.err || '失败', r.step === 'not-sent' ? 'warn' : 'bad');
    log(`${p.name}: ${r.ok ? (r.step + ' / ' + (r.how || '') + ' / ' + (r.via || '')) : r.err}`);
  };
  const serial = !send || state.serial;
  const filled = [];
  for (const p of targets) {
    setBadge(p.id, serial && send ? '发送中…' : '填写中…', '');
    const r = await ask(p.id, { cmd: 'fill', text, send: serial && send }) || { ok: false, err: '无回应' };
    if (serial || !r.ok) report(p, r);
    else { filled.push(p); setBadge(p.id, '已填好，等发送', ''); }
    await sleep(serial ? 400 : 80);
  }
  if (!serial && filled.length) {
    const tFill = performance.now();
    filled.forEach(p => setBadge(p.id, '发送中…', ''));
    const rs = await Promise.all(filled.map(p => ask(p.id, { cmd: 'send', text }, true)));
    rs.forEach((r, i) => report(filled[i], r || { ok: false, err: '无回应' }));
    const ats = rs.filter(r => r && r.at).map(r => r.at);
    log(`填字 ${((tFill - t0) / 1000).toFixed(1)} 秒，发送 ${((performance.now() - tFill) / 1000).toFixed(1)} 秒${ats.length > 1 ? `，各栏发出时间相差 ${((Math.max(...ats) - Math.min(...ats)) / 1000).toFixed(1)} 秒` : ''}`);
  } else log(`用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
  if (state.mode === 'window') chrome.runtime.sendMessage({ type: 'focusTab' });
  window.__aimvLast = results;
  return results;
}

// /clear：勾选的栏全部重新打开该站的「新对话」页面，等于清空聊天上下文（旧对话还在各站的历史记录里）。
// 重新加载后会自动套用主题和深度思考设置。
async function clearAll() {
  const targets = state.panes.filter(p => p.on);
  log(`/clear：${targets.length} 栏开新对话`);
  for (const p of targets) {
    const url = (siteById(p.siteId) || {}).newChat || p.url;
    if (state.mode === 'window') {
      const r = await chrome.runtime.sendMessage({ type: 'navWindow', paneId: p.id, url });
      setBadge(p.id, r && r.ok ? '已开新对话' : (r && r.err) || '失败', r && r.ok ? 'ok' : 'bad');
      continue;
    }
    const l = live.get(p.id);
    if (!l || !l.iframe) continue;
    l.ready = false;
    l.iframe.src = 'about:blank';   // 先清掉，保证即使网址相同也会重新加载
    await sleep(30);
    l.iframe.src = url;
    setBadge(p.id, '开新对话中…');
    watchReady(p.id);
  }
}

// 栏加载好后：套用主题；首次就绪时如果开过「深度思考」也套用
async function applyPane(p, withThink) {
  if (state.mode !== 'iframe') return;
  const r = await askFrame(p.id, { cmd: 'theme', target: themeTarget(), mode: invertOf(p) }, 3000);
  if (r && r.ok) live.get(p.id).badge.dataset.inv = r.inverted ? '1' : '';
  if (withThink && state.think != null) await setThink(p, state.think);
}

async function setThink(p, on) {
  const r = await ask(p.id, { cmd: 'think', on }) || { ok: false, err: '无回应' };
  if (r.ok) setBadge(p.id, (on ? '深度思考：' : '已关：') + r.mode, 'ok');
  else setBadge(p.id, r.err, r.unsupported ? '' : 'warn');
  log(`${p.name} 深度思考${on ? '开' : '关'}：${r.ok ? r.mode : r.err}`);
  return r;
}

async function diagnose() {
  const out = {};
  for (const p of state.panes) {
    const r = await ask(p.id, { cmd: 'probe' }) || { ok: false, err: '无回应' };
    out[p.name] = r;
    if (!r.ok) setBadge(p.id, r.err, 'bad');
    else if (r.input && r.send) setBadge(p.id, '诊断：输入框和按钮都找到', 'ok');
    else if (r.input) setBadge(p.id, '诊断：有输入框，按钮要等填字后才出现或靠回车', 'warn');
    else setBadge(p.id, '诊断：没找到输入框', 'bad');
    log(`${p.name}: ${r.ok ? `host=${r.host} 输入框=${r.input || '无'} 按钮=${r.send || '无'}` : r.err}`);
  }
  window.__aimvDiag = out;
  return out;
}

// ---------- 工具栏 ----------
function wireToolbar() {
  const add = $('#addSite');
  for (const s of SITES) add.add(new Option(s.name, s.id));
  add.add(new Option('自定义网址…', '__custom'));
  add.onchange = () => {
    const v = add.value;
    add.value = '';
    if (!v) return;
    let p;
    if (v === '__custom') {
      const url = prompt('网址（https://…）');
      if (!url || !/^https?:\/\//.test(url)) return;
      p = { id: uid(), siteId: null, name: new URL(url).hostname, url, on: true, w: 1 };
    } else p = mkPane(siteById(v));
    state.panes.push(p);
    save(); render();
  };
  $('#layout').onchange = e => { state.layout = e.target.value; save(); render(); };
  $('#mode').onchange = e => { state.mode = e.target.value; resetPanes(); save(); render(); };
  $('#think').onchange = async e => {
    state.think = e.target.checked; save();
    for (const p of state.panes) { await setThink(p, state.think); await sleep(300); }
  };
  $('#theme').onchange = e => {
    state.theme = e.target.value; save(); applyTheme();
    state.panes.forEach(p => applyPane(p, false));
  };
  mql.addEventListener('change', () => { if (!state.theme || state.theme === 'system') { applyTheme(); state.panes.forEach(p => applyPane(p, false)); } });
  $('#serial').onchange = e => { state.serial = e.target.checked; save(); };
  $('#lazy').onchange = e => { state.lazy = e.target.checked; save(); };
  $('#reset').onclick = () => { if (confirm('恢复默认的 8 个站？当前布局会丢掉。')) { state = defaults(); resetPanes(); save(); render(); } };
  $('#diagnose').onclick = diagnose;
  $('#sendAll').onclick = () => broadcast(true);
  $('#fillAll').onclick = () => broadcast(false);
  $('#prompt').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); broadcast(true); } };
  $('#tile').onclick = async () => {
    const area = { left: screen.availLeft || 0, top: screen.availTop || 0, width: screen.availWidth, height: screen.availHeight };
    const r = await chrome.runtime.sendMessage({ type: 'tileWindows', panes: state.panes.map(p => ({ id: p.id, url: p.url })), area });
    log(r.ok ? `开了 ${r.wins.length} 个窗口` : r.err);
  };
  $('#closeWins').onclick = () => chrome.runtime.sendMessage({ type: 'closeWindows' });
}

// 测试钩子：multiview.html#reload 重新加载整个扩展（改了代码后用）
if (location.hash === '#reload') chrome.runtime.reload();
// 测试钩子：#popout&... 让后台开一个前台窗口打开本页（带上其余参数），然后关掉自己
if (location.hash.startsWith('#popout')) {
  chrome.runtime.sendMessage({ type: 'popout', hash: location.hash.replace(/^#popout&?/, '') });
}

(async () => {
  if (window.top !== window) { document.body.textContent = '不能被嵌入使用。'; return; }
  await load();
  wireToolbar();
  applyTheme();
  // 先让后台给本标签页加好"去掉防嵌入响应头"的规则，再加载 iframe
  const r = await chrome.runtime.sendMessage({ type: 'registerTab' });
  registered = !!(r && r.ok);
  if (!registered) log('注册规则失败：' + (r && r.err));
  render();
  window.__aimv = { broadcast, diagnose, state: () => state };
  autotest();
})();

// 测试钩子：打开 multiview.html#autotest 会等各栏就绪后自动跑一遍诊断；
// #autotest&send=文字 会再把这段文字广播出去。结果写进底部日志和 storage（aimvTest）。
async function autotest() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('autotest')) return;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && [...live.values()].some(l => l.loaded && !l.ready)) await sleep(1000);
  await sleep(4000);
  const ready = Object.fromEntries(state.panes.map(p => [p.name, !!live.get(p.id)?.ready]));
  if (h.get('theme')) { state.theme = h.get('theme'); applyTheme(); for (const p of state.panes) await applyPane(p, false); await sleep(5000); }
  const diag = await diagnose();
  let sent = null, think = null;
  if (h.has('think')) {   // #autotest&think=1 / think=0
    think = {};
    for (const p of state.panes) think[p.name] = await setThink(p, h.get('think') === '1');
  }
  if (h.get('send')) {
    // #autotest&send=文字&only=qwen,kimi ：只发给这几栏（不改保存的勾选）
    const only = h.get('only') ? h.get('only').split(',') : null;
    const saved = state.panes.map(p => p.on);
    if (only) state.panes.forEach(p => { p.on = only.includes(p.siteId); });
    $('#prompt').value = h.get('send');
    sent = await broadcast(true);
    if (only) state.panes.forEach((p, i) => { p.on = saved[i]; });
  }
  await chrome.storage.local.set({ aimvTest: { at: new Date().toISOString(), ready, diag, think, sent } });
  log('自动测试完成');
}
