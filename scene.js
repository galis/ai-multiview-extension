// 场景模式：头脑风暴、竞赛。
// 场景模式下各栏缩成头像，点头像弹出那个网站；主 AI（总结 / 裁判）可以选。
// 各栏的 iframe 仍然叠在页面里（透明、在头像板下面），保证网页照常排版和运行。
const SCENES = {
  brainstorm: {
    name: '头脑风暴', btn: '开始头脑风暴', main: '总结',
    hint: '发一个问题：勾了「参加」的 AI 先各自回答，再看别人的观点讨论一轮，最后由主 AI 总结。'
  },
  contest: {
    name: '竞赛', btn: '开始竞赛', main: '裁判',
    hint: '发一个挑战：除主 AI 外，勾了「参加」的 AI 各自作答；答案去掉名字、打乱顺序后交给主 AI 打分，选出冠军。'
  }
};
const AVATAR = {
  claude: ['Cl', '#d97757'], chatgpt: ['GPT', '#10a37f'], gemini: ['Ge', '#4285f4'], deepseek: ['DS', '#4d6bfe'],
  doubao: ['豆', '#2f6bff'], qwen: ['千', '#615ced'], kimi: ['K', '#111827'], yuanbao: ['元', '#16a34a']
};
// 竞赛时把答案里的自报家门换成「选手」，免得裁判认出是谁
const NAME_RE = /Claude|Anthropic|ChatGPT|GPT-?[\d.o]*|OpenAI|Gemini|Google|谷歌|DeepSeek|深度求索|豆包|字节跳动|通义千问|千问|通义|Qwen|阿里巴巴|阿里云|Kimi|月之暗面|Moonshot|腾讯元宝|元宝|混元|腾讯/gi;
const NOT_FOUND_MS = 60000;  // 发出后这么久还找不到刚发的消息，当作没发出去（多半被限制了），不再等
const STABLE_MS = 8000;      // 文字这么久不变、且没有「停止」按钮，算答完
const DEFAULT_TIMEOUT_MIN = 5;   // 每轮默认最多等 5 分钟，超时的栏不再等
const timeoutMin = () => Math.min(60, Math.max(1, Number(state.timeoutMin) || DEFAULT_TIMEOUT_MIN));

let run = null;              // 进行中的场景：{ abort, skip, timedOut: Map(id -> 原因), think: Map(id -> 思考过程) }
let openId = null;           // 当前弹出的栏
const lastStatus = new Map();

const inScene = () => (state && SCENES[state.scene]) || null;
const clip = (t, n) => t.length <= n ? t : t.slice(0, Math.round(n * 0.7)) + '\n……（中间省略）……\n' + t.slice(-Math.round(n * 0.3));

function mainPane() {
  return state.panes.find(x => x.id === state.judge) || state.panes.find(x => x.siteId === 'deepseek') || state.panes[0];
}

function openPane(id) {
  openId = id;
  document.querySelectorAll('.pane.open').forEach(e => e.classList.remove('open'));
  const el = id && paneEls.get(id);
  if (el) el.classList.add('open');
  document.body.classList.toggle('popup', !!el);
}

function setStatus(id, text, cls = '') {
  lastStatus.set(id, [text, cls]);
  const av = document.querySelector(`.av[data-id="${id}"]`);
  if (!av) return;
  av.querySelector('.st').textContent = text;
  av.querySelector('.st').title = text;
  av.dataset.state = cls;
}

function renderBoard() {
  const sc = inScene();
  $('#scene').value = sc ? state.scene : 'none';
  $('#sendAll').textContent = sc ? (run ? '进行中…' : sc.btn) : '发送到全部';
  $('#sendAll').disabled = !!run;
  $('#fillAll').style.display = sc ? 'none' : '';
  if (!sc) { openPane(null); return; }
  const m = mainPane();
  state.judge = m && m.id;
  const sel = $('#judge');
  sel.innerHTML = '';
  state.panes.forEach(p => sel.add(new Option(p.name, p.id)));
  sel.value = state.judge || '';
  $('#mainLabel').textContent = `主 AI（${sc.main}）`;
  $('#sceneHint').textContent = sc.hint;
  $('#skipWait').disabled = $('#stopScene').disabled = !run;
  $('#timeoutMin').value = timeoutMin();

  const box = $('#avatars');
  box.innerHTML = '';
  for (const p of state.panes) {
    const [t, c] = AVATAR[p.siteId] || [p.name.slice(0, 2), '#64748b'];
    const isMain = p.id === state.judge;
    const d = document.createElement('div');
    d.className = 'av' + (isMain ? ' main' : '');
    d.dataset.id = p.id;
    d.innerHTML = `<button class="face"></button><div class="nm"></div><div class="st">待命</div>
      <label class="join"><input type="checkbox"> 参加</label><div class="role"></div>`;
    const face = d.querySelector('.face');
    face.textContent = t;
    face.style.background = c;
    face.title = `点开看 ${p.name}`;
    face.onclick = () => openPane(p.id);
    d.querySelector('.nm').textContent = p.name;
    const cb = d.querySelector('input');
    cb.checked = p.on;
    cb.onchange = () => { p.on = cb.checked; save(); };
    // 竞赛里主 AI 只当裁判，不参赛
    if (isMain && state.scene === 'contest') d.querySelector('.join').style.display = 'none';
    d.querySelector('.role').textContent = isMain ? '👑 ' + sc.main : '';
    box.appendChild(d);
    const ls = lastStatus.get(p.id);
    if (ls) setStatus(p.id, ...ls);
  }
  if (openId) openPane(openId);
}

function wireScene() {
  $('#scene').onchange = e => { state.scene = e.target.value === 'none' ? null : e.target.value; save(); render(); };
  $('#judge').onchange = e => { state.judge = e.target.value; save(); renderBoard(); };
  $('#timeoutMin').onchange = e => { state.timeoutMin = Math.min(60, Math.max(1, Math.round(Number(e.target.value)) || DEFAULT_TIMEOUT_MIN)); e.target.value = state.timeoutMin; save(); };
  $('#skipWait').onclick = () => { if (run) { run.skip = true; log('不等了：用现有回答继续'); } };
  $('#stopScene').onclick = () => { if (run) { run.abort = true; run.skip = true; log('停止场景'); } };
  $('#backdrop').onclick = () => openPane(null);
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (openId) openPane(null);
    else if (state.rec) { setRec(false); save(); }
  });
  $('#recMode').onchange = e => { setRec(e.target.checked); save(); };
  $('#recExit').onclick = () => { setRec(false); save(); };
  setRec(state.rec || location.hash.includes('rec=1'));
}

// ---------- 记录区 ----------
function addRound(title) {
  const r = document.createElement('div');
  r.className = 'round';
  const h = document.createElement('h3');
  const t = document.createElement('span');
  t.textContent = title;
  // 一键全部展开 / 全部收起；有 2 份以上回答才显示
  const b = document.createElement('button');
  b.className = 'toggle-all';
  b.hidden = true;
  b.onclick = () => {
    const ds = [...r.querySelectorAll(':scope > details')];
    const open = !ds.every(d => d.open);
    ds.forEach(d => { d.open = open; });
    syncToggle(r);
  };
  h.append(t, b);
  r.appendChild(h);
  $('#rounds').appendChild(r);
  return r;
}
function syncToggle(round) {
  const b = round.querySelector('.toggle-all');
  const ds = [...round.querySelectorAll(':scope > details')];
  b.hidden = ds.length < 2;
  b.textContent = ds.length && ds.every(d => d.open) ? '全部收起' : '全部展开';
}
// 一条回答 = 一条像微信聊天列表的消息：头像、名字、字数，下面一行灰色预览；点开看全文。默认收起
function addAnswer(round, p, text, late = '', think = '') {
  const d = document.createElement('details');
  d.className = 'msg';
  const s = document.createElement('summary');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const top = document.createElement('div');
  top.className = 'top';
  const nm = document.createElement('span');
  nm.className = 'who' + (late ? ' late' : '');
  nm.textContent = p.name + (late ? ` · ${late}` : '');
  const cnt = document.createElement('span');
  cnt.className = 'cnt';
  cnt.textContent = text ? text.length + ' 字' : '没拿到回答';
  top.append(nm, cnt);
  const pv = document.createElement('div');
  pv.className = 'preview';
  pv.textContent = text ? text.replace(/\s+/g, ' ').trim() : '';
  meta.append(top, pv);
  s.append(miniFace(p), meta);
  d.append(s);
  if (think) {
    const th = document.createElement('details');
    th.className = 'think';
    const ts = document.createElement('summary');
    ts.textContent = `思考过程（${think.length} 字）`;
    const tt = document.createElement('div');
    tt.className = 'txt';
    tt.textContent = think;
    th.append(ts, tt);
    d.append(th);
  }
  const pre = document.createElement('div');
  pre.className = 'txt';
  pre.textContent = text || '';
  d.append(pre);
  d.ontoggle = () => syncToggle(round);
  round.appendChild(d);
  syncToggle(round);
  round.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

// ---------- 发送和等回答 ----------
// 每栏的字不一样：先依次填字（要焦点），再同时点发送
async function sendEach(items) {
  const ok = [];
  for (const it of items) {
    if (run.abort) break;
    setStatus(it.p.id, '填写中…', 'busy');
    const r = await ask(it.p.id, { cmd: 'fill', text: it.text, send: false }) || { ok: false, err: '无回应' };
    if (r.ok) ok.push(it);
    else { setStatus(it.p.id, r.err || '填不进去', 'bad'); log(`${it.p.name}: ${r.err}`); }
    await sleep(80);
  }
  const rs = await Promise.all(ok.map(it => ask(it.p.id, { cmd: 'send', text: it.text }, true)));
  return ok.filter((it, i) => {
    const r = rs[i] || { ok: false, err: '无回应' };
    setStatus(it.p.id, r.ok ? '已发送，等回答' : (r.err || '没发出去'), r.ok ? 'busy' : 'bad');
    if (!r.ok) log(`${it.p.name}: ${r.err}`);
    return r.ok;
  });
}

async function waitReplies(items, marker, onDone) {
  const st = new Map(items.map(it => [it.p.id, { text: '', changed: Date.now(), done: false }]));
  const t0 = Date.now();
  const cap = timeoutMin() * 60000;   // 这一轮开始时定下，中途改设置下一轮生效
  run.skip = false;
  for (;;) {
    const pend = items.filter(it => !st.get(it.p.id).done);
    if (!pend.length) break;
    await Promise.all(pend.map(async it => {
      const s = st.get(it.p.id);
      const r = await ask(it.p.id, { cmd: 'reply', marker, prompt: it.text }, true);
      const now = Date.now();
      if (r && r.ok && r.found && r.think && r.think !== s.think) { s.think = r.think; s.changed = now; }
      if (r && r.ok && r.found && r.text && r.text !== s.text) { s.text = r.text; s.changed = now; s.seen = true; }
      if (r && r.ok && r.found) s.seen = true;
      const busy = r && r.busy;
      if (run.skip) s.done = true;
      else if (r && r.limited) {
        s.done = true; s.late = '被限制';
        run.timedOut.set(it.p.id, s.late);
        log(`${it.p.name}: 被限制（${r.limited}），不再等`);
      }
      else if (!s.seen && now - t0 > NOT_FOUND_MS) {
        s.done = true; s.late = '没发出去';
        run.timedOut.set(it.p.id, s.late);
        log(`${it.p.name}: 发出 ${NOT_FOUND_MS / 1000} 秒还找不到刚发的消息，多半没发出去（可能被限制），不再等`);
      }
      else if (s.text && !busy && now - s.changed >= STABLE_MS) s.done = true;
      else if (now - t0 > cap) {
        s.done = true; s.late = '超时';
        run.timedOut.set(it.p.id, s.late);
        log(`${it.p.name}: 超时（${cap / 60000} 分钟），不再等${s.text ? '，用已有的 ' + s.text.length + ' 字' : '，没拿到回答'}`);
      }
      if (s.late) setStatus(it.p.id, s.text ? `${s.late} · ${s.text.length} 字` : `${s.late} · 没拿到回答`, 'late');
      else if (s.done) setStatus(it.p.id, s.text ? `答完 · ${s.text.length} 字` : '没拿到回答', s.text ? 'ok' : 'bad');
      // 谁先答完谁先出一条消息
      if (s.done && !s.fired) { s.fired = true; if (s.think) run.think.set(it.p.id, s.think); if (onDone) onDone(it, s); }
      if (!s.done) setStatus(it.p.id, s.text ? `回答中 · ${s.text.length} 字` : (!r ? '无回应' : !r.ok ? '读不到：' + r.err : !r.found ? '找不到刚发的消息' : '思考中…'), 'busy');
    }));
    if (run.skip) break;
    await sleep(2500);
  }
  for (const [id, s] of st) if (s.think) run.think.set(id, s.think);
  return new Map([...st].map(([id, s]) => [id, s.text]));
}

// 一轮：发出去、等回答、记下来
async function roundAsk(title, items, marker) {
  const round = addRound(title);
  const sent = await sendEach(items);
  const shown = new Set();
  const post = (it, text) => {
    if (shown.has(it.p.id)) return;
    shown.add(it.p.id);
    addAnswer(round, it.p, text || '', run.timedOut.get(it.p.id) || '', run.think.get(it.p.id) || '');
  };
  const got = run.abort ? new Map() : await waitReplies(sent, marker, (it, st) => post(it, st.text));
  // 没发出去、被跳过的也补一条，排在最后
  for (const it of items) post(it, got.get(it.p.id));
  return got;
}

// ---------- 两个场景 ----------
async function runScene(q) {
  const sc = inScene();
  if (run) return log('场景还在进行中');
  const main = mainPane();
  if (!main) return log('没有可用的栏');
  const players = state.panes.filter(p => p.on && (state.scene === 'brainstorm' || p.id !== main.id));
  if (players.length < 2) return log(`至少要勾 2 个${state.scene === 'contest' ? '选手（主 AI 不算）' : '参加的 AI'}`);
  run = { abort: false, skip: false, timedOut: new Map(), think: new Map() };
  lastStatus.clear();
  $('#prompt').value = '';
  $('#rounds').innerHTML = '';
  const q0 = document.createElement('div');
  q0.className = 'question';
  q0.textContent = `${sc.name}：${q}`;
  $('#rounds').appendChild(q0);
  renderBoard();
  log(`${sc.name}开始：${players.length} 个 AI 参加，${main.name} ${sc.main}`);
  try {
    if (state.scene === 'brainstorm') await brainstorm(q, main, players);
    else await contest(q, main, players);
    log(run.abort ? `${sc.name}已停止` : `${sc.name}完成`);
  } catch (e) {
    log(`${sc.name}出错：${e}`);
  } finally {
    run = null;
    renderBoard();
  }
}

async function brainstorm(q, main, players) {
  const rid = uid().slice(0, 4);
  const mk1 = `【头脑风暴·第1轮·${rid}】`;
  const t1 = `${mk1}\n${q}\n\n（这是多个 AI 一起参加的头脑风暴。请给出你的观点和理由，简明扼要。）`;
  const r1 = await roundAsk('第 1 轮 · 各自回答', players.map(p => ({ p, text: t1 })), mk1);
  if (run.abort) return;
  const got1 = players.filter(p => r1.get(p.id));
  let r2 = new Map();
  if (got1.length >= 2) {
    const mk2 = `【头脑风暴·第2轮·${rid}】`;
    const items = got1.map(p => ({
      p,
      text: `${mk2}\n头脑风暴第 2 轮。题目：${q}\n\n其他 AI 第 1 轮的观点：\n\n` +
        got1.filter(o => o !== p).map(o => `【${o.name}】\n${clip(r1.get(o.id), 1500)}`).join('\n\n') +
        '\n\n请评论这些观点：同意哪些、不同意哪些、有什么补充，然后给出你修正后的看法。简明扼要。'
    }));
    r2 = await roundAsk('第 2 轮 · 互相讨论', items, mk2);
    if (run.abort) return;
    showClash(got1, r2);
  }
  // 主 AI 自己参加了的话，它的发言已经在它的对话里，不用再贴
  const views = players.filter(p => p.id !== main.id).map(p => [p, r2.get(p.id) || r1.get(p.id)]).filter(([, t]) => t);
  if (!views.length) return log('没拿到任何回答，不做总结');
  const mk3 = `【头脑风暴·总结·${rid}】`;
  const t3 = `${mk3}\n头脑风暴结束，请你来总结。题目：${q}\n\n各 AI 讨论后的看法：\n\n` +
    views.map(([p, t]) => `【${p.name}】\n${clip(t, 2000)}`).join('\n\n') +
    '\n\n请总结：大家的共识、主要分歧、最有价值的点子，最后给出你的结论。';
  const r3 = await roundAsk(`总结 · ${main.name}`, [{ p: main, text: t3 }], mk3);
  const fin = r3.get(main.id);
  if (fin) showFinal(`${main.name} 的总结`, fin);
}

async function contest(q, main, players) {
  const rid = uid().slice(0, 4);
  const mk1 = `【竞赛·${rid}】`;
  const t1 = `${mk1}\n${q}\n\n（这是多个 AI 参加的比赛，请给出你的最佳答案。）`;
  const r1 = await roundAsk('选手作答', players.map(p => ({ p, text: t1 })), mk1);
  if (run.abort) return;
  const entries = players.filter(p => r1.get(p.id));
  if (entries.length < 2) return log('拿到的答案不到 2 份，不做裁定');
  // 打乱顺序，编号 A、B、C…
  for (let i = entries.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [entries[i], entries[j]] = [entries[j], entries[i]]; }
  const tag = i => String.fromCharCode(65 + i);
  const mk2 = `【竞赛裁判·${rid}】`;
  const t2 = `${mk2}\n你是这场 AI 比赛的裁判。题目：${q}\n\n各选手的答案（已去掉名字，顺序随机）：\n\n` +
    entries.map((p, i) => `【选手${tag(i)}】\n${clip(r1.get(p.id).replace(NAME_RE, '选手'), 3000)}`).join('\n\n') +
    '\n\n请逐个点评并打分（10 分制），说明理由，最后单独一行写「冠军：选手X」。';
  const r2 = await roundAsk(`裁定 · ${main.name}`, [{ p: main, text: t2 }], mk2);
  const verdict = r2.get(main.id);
  const map = entries.map((p, i) => `选手${tag(i)} = ${p.name}`).join('　');
  const m = verdict && [...verdict.matchAll(/冠军\s*[:：]\s*\**\s*选手\s*([A-Z])/g)].pop();
  const win = m && entries[m[1].charCodeAt(0) - 65];
  if (win) {
    setStatus(win.id, '🏆 冠军', 'win');
    log(`冠军：${win.name}`);
  }
  showFinal(win ? `🏆 冠军：${win.name}（选手${m[1]}）` : `${main.name} 的裁定`, (verdict || '没拿到裁定') + '\n\n——\n' + map);
}

// ---------- 互怼气泡：第 2 轮里点名别人的那句话 ----------
const ALIAS = {
  claude: ['Claude'], chatgpt: ['ChatGPT', 'GPT'], gemini: ['Gemini'], deepseek: ['DeepSeek', '深度求索'],
  doubao: ['豆包'], qwen: ['千问', '通义'], kimi: ['Kimi'], yuanbao: ['元宝']
};
// 先认反对（「不同意」也含「同意」），再认同意，最后才是补充（「但」太常见）
const STANCE = [
  ['反对', '⚔️', /不同意|反对|不认同|不赞同|质疑|不太同意|不完全同意|有问题|站不住|过于|太理想|忽略了|反驳/],
  ['同意', '🤝', /同意|赞同|认同|说得对|支持/],
  ['补充', '➕', /补充|还要|还应|另外|此外|但|不过|可以再/]
];
const namesOf = p => ALIAS[p.siteId] || [p.name];
function clashLines(speakers, texts) {
  const out = [];
  for (const p of speakers) {
    const t = (texts.get(p.id) || '').replace(/\*\*|__|`/g, '');
    const sents = t.split(/(?<=[。！？!?；;])|\n/).map(x => x.replace(/^[\s\-*•\d.、)）]+/, '').trim()).filter(x => x.length >= 6);
    const found = [];
    for (const s of sents) {
      // 指向句子里最先出现的那个名字
      const low = s.toLowerCase();
      const pos = o => Math.min(...namesOf(o).map(n => { const k = low.indexOf(n.toLowerCase()); return k < 0 ? 1e9 : k; }));
      const to = speakers.filter(o => o !== p && pos(o) < 1e9).sort((a, b) => pos(a) - pos(b))[0];
      if (!to) continue;
      const st = STANCE.find(([, , re]) => re.test(s)) || ['点名', '💬'];
      found.push({ from: p, to, kind: st[0], icon: st[1], text: s.length > 56 ? s.slice(0, 54) + '…' : s, rank: ['反对', '补充', '点名', '同意'].indexOf(st[0]) });
    }
    found.sort((a, b) => a.rank - b.rank);
    // 每个 AI 最多两句；有反对的先上
    out.push(...found.slice(0, found[0] && found[0].kind === '反对' ? 2 : 1));
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 10);
}
function miniFace(p) {
  const [t, c] = AVATAR[p.siteId] || [p.name.slice(0, 2), '#64748b'];
  const f = document.createElement('span');
  f.className = 'mini';
  f.textContent = t;
  f.style.background = c;
  f.title = p.name;
  return f;
}
function showClash(speakers, texts) {
  const lines = clashLines(speakers, texts);
  if (!lines.length) return;
  const d = document.createElement('div');
  d.className = 'clash';
  const h = document.createElement('h3');
  h.textContent = `第 2 轮 · 谁怼了谁（${lines.filter(l => l.kind === '反对').length} 处反对）`;
  d.appendChild(h);
  lines.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'bubble k-' + l.kind;
    row.style.animationDelay = (i * 0.6) + 's';
    const who = document.createElement('div');
    who.className = 'who';
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = l.icon;
    arrow.title = l.kind;
    who.append(miniFace(l.from), arrow, miniFace(l.to));
    const q = document.createElement('div');
    q.className = 'say';
    q.textContent = `${l.from.name} → ${l.to.name}：「${l.text}」`;
    row.append(who, q);
    d.appendChild(row);
  });
  $('#rounds').appendChild(d);
  d.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------- 录屏模式：竖屏 9:16，只留头像板和记录，字放大 ----------
function setRec(on) {
  state.rec = !!on;
  document.documentElement.classList.toggle('rec', state.rec);
  $('#recMode').checked = state.rec;
}

function showFinal(title, text) {
  const d = document.createElement('div');
  d.className = 'final';
  const h = document.createElement('h3');
  h.textContent = title;
  const t = document.createElement('div');
  t.className = 'txt';
  t.textContent = text;
  d.append(h, t);
  $('#rounds').appendChild(d);
  d.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
