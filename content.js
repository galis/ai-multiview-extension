// 注入到所有页面的所有 frame，但只在两种情况下动作：
//  1) 自己是插件并排页的直接子框架（收 postMessage 指令）；
//  2) 后台给本标签页发 runtime 消息（只发给多窗口模式里插件自己开的窗口）。
// 其它情况什么都不做。
(() => {
  if (window.__aimvLoaded) return;
  window.__aimvLoaded = true;

  const EXT_ORIGIN = 'chrome-extension://' + chrome.runtime.id;
  const parentIsUs = window.top !== window && location.ancestorOrigins && location.ancestorOrigins[0] === EXT_ORIGIN;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // display: contents 的元素自己不占位置（ChatGPT 改版后整块回答就是这样），看里面有没有可见的子元素
  const visible = el => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'contents') return [...el.children].some(visible);
    return el.getClientRects().length > 0 && cs.visibility !== 'hidden';
  };

  function cfg() {
    const site = self.AIMV_findSite(location.hostname);
    return {
      site,
      input: [...(site ? site.input : []), ...self.AIMV_GENERIC.input],
      send: [...(site ? site.send : []), ...self.AIMV_GENERIC.send]
    };
  }

  function queryFirst(selectors, pred = () => true) {
    for (const sel of selectors) {
      let list;
      try { list = document.querySelectorAll(sel); } catch { continue; }
      for (const el of list) if (visible(el) && pred(el)) return { el, sel };
    }
    return null;
  }

  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    for (;;) {
      const r = fn();
      if (r) return r;
      if (Date.now() - t0 > timeout) return null;
      await sleep(150);
    }
  }

  const enabled = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/(^|\s|--)disabled(\s|$)/.test(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className);
  const norm = s => (s || '').replace(/\s+/g, '');

  function textOf(el) {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText;
  }

  // 编辑器（React/Slate/Lexical）更新 DOM 是异步的，检查前要等一下，不然会误判没填上而重复填。
  async function setText(el, text, method) {
    const key = norm(text).slice(0, 20);
    const has = async () => { for (let i = 0; i < 8; i++) { if (norm(textOf(el)).includes(key)) return true; await sleep(100); } return false; };
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return (await has()) ? 'value' : null;
    }
    // contenteditable：先全选并删掉旧内容（草稿），再插入
    const selectAll = async () => {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      await sleep(60);   // 让编辑器处理 selectionchange
    };
    if (norm(textOf(el))) {
      await selectAll();
      document.execCommand('delete');
      await sleep(150);
    }
    await selectAll();
    if (method !== 'paste') {
      document.execCommand('insertText', false, text);
      if (await has()) return 'insertText';
    }
    // 退路 / 指定粘贴：模拟粘贴事件
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    if (await has()) return 'paste';
    // 再退：beforeinput
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
    return (await has()) ? 'beforeinput' : null;
  }

  function pressEnter(el) {
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  async function probe() {
    const c = cfg();
    const inp = queryFirst(c.input);
    const btn = queryFirst(c.send);
    return {
      ok: true, host: location.hostname, site: c.site ? c.site.name : null,
      input: inp ? inp.sel : null, send: btn ? btn.sel : null, sendEnabled: btn ? enabled(btn.el) : null
    };
  }

  async function fill(text, doSend) {
    const c = cfg();
    const inp = await waitFor(() => queryFirst(c.input), 4000);
    if (!inp) return { ok: false, err: '没找到输入框（可能未登录或页面改版）' };
    const how = await setText(inp.el, text, c.site && c.site.fill);
    if (!how) return { ok: false, err: '输入框找到了但填不进字', input: inp.sel };
    await sleep(150);
    if (!doSend) return { ok: true, step: 'filled', how, input: inp.sel };
    return { ...(await sendNow(text)), how };
  }

  // 点发送（不需要焦点，所以各栏可以同时点）。前提：字已经填好。
  async function sendNow(text) {
    const c = cfg();
    const key = norm(text).slice(0, 20);
    const inp = queryFirst(c.input);
    if (!inp) return { ok: false, err: '没找到输入框' };
    const lim = limitNow();   // 限制弹窗已经在了，发了也白发
    if (lim) return { ok: false, limited: lim, err: '被限制：' + lim };
    if (!norm(textOf(inp.el)).includes(key)) return { ok: false, err: '输入框里没有要发的字（填字那一步失败了）' };
    const btn = await waitFor(() => queryFirst(c.send, enabled), 3000);
    if (btn) btn.el.click();
    else pressEnter(inp.el);
    // 发出去的标志：输入框清空（输入框可能被换成新元素，所以重新找）
    const cleared = await waitFor(() => {
      const cur = queryFirst(c.input);
      return !cur || !norm(textOf(cur.el)).includes(key);
    }, 4000);
    // 只在没找到按钮时才按回车；点过按钮就不再补回车，免得发两次
    return {
      ok: !!cleared, step: cleared ? 'sent' : 'not-sent', via: btn ? 'button' : 'enter',
      input: inp.sel, send: btn ? btn.sel : null, at: Date.now(),
      err: cleared ? undefined : (btn ? '点了发送，但输入框没清空，可能要登录或被拦' : '没找到可点的发送按钮，按回车也没发出去')
    };
  }

  // 有些菜单（Radix 等）只认 pointerdown，不认单独的 click
  function realClick(el) {
    const o = { bubbles: true, cancelable: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }
  const firstLine = el => (el.innerText || '').trim().split('\n')[0].trim();

  // 深度思考：按 sites.js 里的 think 配置去点开关或菜单
  async function think(on) {
    const c = cfg();
    const t = c.site && c.site.think;
    if (!t) return { ok: false, unsupported: true, err: '这个站没做自动切换，请在栏里手动选' };
    const lim = limitNow();   // 限制弹窗挡着，点不了菜单，不用等
    if (lim) return { ok: false, limited: lim, err: '被限制：' + lim };
    if (t.type === 'toggle') {
      // 栏刚加载完时输入区可能还没渲染出来，最多等 8 秒
      const el = await waitFor(() => [...document.querySelectorAll(t.sel)].find(e => visible(e) && firstLine(e) === t.text), 8000);
      if (!el) return { ok: false, err: '没找到「' + t.text + '」开关' };
      const cur = el.getAttribute(t.onAttr) === 'true';
      if (cur !== on) { realClick(el); await sleep(400); }
      return { ok: (el.getAttribute(t.onAttr) === 'true') === on, mode: on ? t.text : '关' };
    }
    if (t.type === 'menu') {
      const want = on ? t.on : t.off;
      const trig = await waitFor(() => [...document.querySelectorAll(t.trigger)].find(e => visible(e) && (!t.triggerText || [].concat(t.triggerText).some(x => firstLine(e) === x || (e.getAttribute('aria-label') || '') === x || (typeof t.triggerText === 'string' && (e.innerText || '').includes(x)))) && (e.innerText || '').length < 30), 8000);
      if (!trig) return { ok: false, err: '没找到模型/模式菜单' };
      realClick(trig);
      const item = await waitFor(() => [...document.querySelectorAll(t.item)].find(e => visible(e) && firstLine(e) === want), 2000);
      if (!item) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { ok: false, err: '菜单里没有「' + want + '」（可能要登录或会员）' };
      }
      realClick(item);
      await sleep(400);
      // 有的菜单（千问）选完不自动收起：按 Esc 关掉
      if ([...document.querySelectorAll(t.item)].some(visible)) {
        const esc = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true };
        (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', esc));
        document.dispatchEvent(new KeyboardEvent('keydown', esc));
      }
      return { ok: true, mode: want };
    }
    return { ok: false, err: 'think 配置有误' };
  }

  // 主题：给整页加反色滤镜，把浅色页面变深（或深色页面变浅），图片和视频再反回来保持原色。
  // mode = auto：量一下页面实际底色，和想要的主题不一致才反色；on：一直反色；off：不动。
  function setInvert(on) {
    let st = document.getElementById('__aimv_dark');
    if (on && !st) {
      st = document.createElement('style');
      st.id = '__aimv_dark';
      st.textContent = `html{filter:invert(.92) hue-rotate(180deg)!important}
img,video,canvas,picture,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}`;
      document.documentElement.appendChild(st);
    } else if (!on && st) st.remove();
  }

  // 页面本身（不算我们的滤镜）是不是深色：取几个点，往上找第一个不透明的背景色，算亮度
  function pageIsDark() {
    const had = !!document.getElementById('__aimv_dark');
    if (had) setInvert(false);
    // 颜色可能是 rgb()、oklch()、color(srgb …) 等任意写法：画到 1×1 画布上再读像素，统一成 RGBA
    const ctx = (pageIsDark.ctx ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true }));
    const rgba = css => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data; };
    const lum = el => {
      for (; el && el.nodeType === 1; el = el.parentElement) {
        const [r, g, b, a] = rgba(getComputedStyle(el).backgroundColor);
        if (a > 128) return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      }
      return null;
    };
    const W = innerWidth, H = innerHeight;
    const pts = [[W / 2, H / 2], [W / 2, 60], [W / 4, H * 0.75], [W * 0.75, H / 3]];
    const vals = pts.map(([x, y]) => lum(document.elementFromPoint(x, y))).filter(v => v !== null);
    if (had) setInvert(true);
    if (!vals.length) return /dark/.test(getComputedStyle(document.documentElement).colorScheme);
    return vals.filter(v => v < 0.4).length > vals.length / 2;
  }

  let themeTimers = [];
  function theme(target, mode) {
    themeTimers.forEach(clearTimeout);
    themeTimers = [];
    const apply = () => {
      const dark = pageIsDark();
      setInvert(mode === 'on' || (mode === 'auto' && dark !== (target === 'dark')));
      return dark;
    };
    const dark = apply();
    // 单页应用加载时底色会变，过一会儿再量两次
    if (mode === 'auto') themeTimers = [1500, 4000].map(ms => setTimeout(apply, ms));
    return { ok: true, pageDark: dark, inverted: !!document.getElementById('__aimv_dark') };
  }


  // ---------- 读回答（场景模式用） ----------
  // 页面每 2~3 秒问一次：找到我们发出的那条消息（以唯一标记开头），取它后面新出现的文字。
  // 是否答完由页面判断：文字一段时间不再变、且没有「停止生成」按钮。
  const STOP_RE = /(^|[^a-z])stop|停止|中止|取消生成/i;
  function busy() {
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      if (!visible(el)) continue;
      const cls = typeof el.className === 'string' ? el.className : '';
      const s = [el.getAttribute('aria-label'), el.getAttribute('data-testid'), el.getAttribute('title'), cls, (el.innerText || '').length < 12 ? el.innerText : ''].join(' ');
      if (STOP_RE.test(s)) return true;
    }
    return false;
  }
  const NOISE = /可能会犯错|can make mistakes|内容由\s*AI\s*生成|AI\s*生成.*仅供参考|请核查重要信息|check important info/i;
  const UI_LINE = /^(编辑|复制|分享|重新生成|重试|点赞|点踩|朗读|收藏|引用|Edit|Copy|Share|Retry|Regenerate|思考已完成|已深度思考.{0,20}|已思考.{0,20}|思考|最新一条回复|(ChatGPT|Gemini|Claude|DeepSeek|豆包|Kimi|元宝|千问)\s*(说|said)\s*[:：]?)$/i;
  function cleanReply(t) {
    return t.split('\n').filter(l => !(l.length < 60 && NOISE.test(l)) && !UI_LINE.test(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  const isScroller = a => /auto|scroll/.test(getComputedStyle(a).overflowY) && a.scrollHeight > a.clientHeight + 20;
  // 从 el 里标记出现的位置开始，按文档顺序取到聊天滚动区结尾的文字（跳过输入框所在部分）
  function textAfter(el, marker, inpEl) {
    const t = el.innerText || '';
    const parts = [t.slice(Math.max(0, t.indexOf(marker)))];
    for (let a = el; a && a !== document.body && !isScroller(a); a = a.parentElement) {
      for (let sib = a.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (inpEl && sib.contains(inpEl)) continue;
        if (sib.matches('nav,aside,footer,textarea') || sib.querySelector('textarea')) continue;
        if (!visible(sib)) continue;
        parts.push(sib.innerText || '');
      }
    }
    return parts.join('\n');
  }
  // 去掉开头那段「我们发的问题」：逐个非空白字符和问题对齐，对不上就停（问题被折叠时也能停住）
  function stripPrompt(t, prompt) {
    const pn = norm(prompt);
    let i = 0, k = 0;
    for (; i < t.length && k < pn.length; i++) {
      if (/\s/.test(t[i])) continue;
      if (t[i] !== pn[k]) break;
      k++;
    }
    return { rest: t.slice(i), matched: k };
  }
  // 含标记的最内层元素。标记可能被拆进几个 span（豆包等），所以按 textContent 找
  function markerEls(marker) {
    const out = [];
    const walk = el => {
      let deeper = false;
      for (const ch of el.children) if ((ch.textContent || '').includes(marker)) { deeper = true; walk(ch); }
      if (!deeper) out.push(el);
    };
    if ((document.body.textContent || '').includes(marker)) walk(document.body);
    return out;
  }
  // 被限制（发太频繁、次数用完）：提示多半是几秒就消失的弹窗，所以一直盯着页面新冒出来的字，记下最近一次
  const LIMIT_RE = /(请求|操作|访问|发送|提问|消息|对话).{0,4}(过于|太过|太|较为)频繁|频率(过高|超限|限制)|(次数|额度|配额|用量)(已)?(用完|用尽|耗尽|不足|达到上限|已达上限)|(已|达到|超出|超过)(了)?(今日|今天|本日|当前)?.{0,6}(上限|限额)|稍后再(试|来|问)|休息一下再|服务(繁忙|拥挤)|(人数|用户|人)(太|过|较)多|太多人|优先队列|排队(中|人数)|当前(使用|访问)?人数(过多|较多)|rate.?limit|too many (requests|messages)|usage limit|limit reached|reached (your|the) .{0,20}limit|try again later/i;
  let limitHit = null;     // { text, t }
  let sentAt = 0;
  // 只认浮层里的提示（弹窗、toast、固定定位的条），不看聊天正文，免得回答里写了「上限」被当成限制
  const inOverlay = el => {
    if (el.closest('[role="alert"],[role="alertdialog"],[role="dialog"],[role="status"]')) return true;
    for (let a = el; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).position === 'fixed') return true;
    return false;
  };
  const limitText = el => {
    const t = (el.innerText || el.textContent || '').trim();
    if (!t || t.length > 160 || !LIMIT_RE.test(t) || !inOverlay(el)) return '';
    return t.split('\n').find(l => LIMIT_RE.test(l)) || t;   // 取命中的那一行，不要弹窗标题「提示」
  };
  new MutationObserver(ms => {
    if (!sentAt) return;
    for (const m of ms) for (const n of m.addedNodes) {
      const el = n.nodeType === 1 ? n : n.parentElement;
      if (!el || el.closest('textarea,[contenteditable="true"]')) continue;
      const t = limitText(el);
      if (t) limitHit = { text: t.slice(0, 60), t: Date.now() };
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: false });
  // 还挂在页面上的提示（弹窗、toast）
  function limitNow() {
    for (const el of document.querySelectorAll('[role="alert"],[role="alertdialog"],[role="dialog"],[role="status"],[class*="toast"],[class*="Toast"],[class*="notice"],[class*="Notice"],[class*="modal"],[class*="Modal"]')) {
      if (!visible(el) || el.closest('textarea,[contenteditable="true"]')) continue;
      const t = limitText(el);
      if (t) return t.slice(0, 60);
    }
    return limitHit && limitHit.t >= sentAt ? limitHit.text : '';
  }

  // 思考过程：class 里带 think / reason / thought 的块（Kimi 是 .thinking-container），站点也可以在 sites.js 里给 thinkSel。
  // 只取标记那条消息后面的、最外层的，返回各块的文字
  const THINK_SEL = '[class*="think" i],[class*="reason" i],[class*="thought" i]';
  function thinkBlocks(after, inpEl, extra) {
    const hits = [...document.querySelectorAll(extra ? THINK_SEL + ',' + extra : THINK_SEL)].filter(e =>
      visible(e) && !e.closest('nav,aside,textarea,button') && !(inpEl && (e.contains(inpEl) || inpEl.closest('form,footer') && inpEl.closest('form,footer').contains(e))) &&
      (after.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && !e.contains(after));
    return hits.filter(e => !hits.some(o => o !== e && o.contains(e))).filter(e => (e.innerText || '').trim().length > 15);
  }

  function reply(marker, prompt) {
    const c = cfg();
    const inp = queryFirst(c.input);
    let best = null;
    const cands = markerEls(marker).filter(el => visible(el) && !el.closest('nav,aside,textarea') && !(inp && inp.el.contains(el)));
    // 思考过程：先记下文字，再临时藏起来读回答（innerText 不含 display:none 的元素），读完马上恢复
    const thinkEls = cands.length ? thinkBlocks(cands[0], inp && inp.el, c.site && c.site.thinkSel) : [];
    const think = cleanReply(thinkEls.map(e => e.innerText || '').join('\n\n'));
    const saved = thinkEls.map(e => [e, e.style.getPropertyValue('display'), e.style.getPropertyPriority('display')]);
    thinkEls.forEach(e => e.style.setProperty('display', 'none', 'important'));
    try {
      for (const el of cands) {
        const r = stripPrompt(textAfter(el, marker, inp && inp.el), prompt || marker);
        if (!best || r.matched > best.matched) best = r;
      }
    } finally {
      for (const [e, v, pr] of saved) v ? e.style.setProperty('display', v, pr) : e.style.removeProperty('display');
    }
    if (!best) return { ok: true, found: false, busy: busy(), limited: limitNow() };
    let rest = best.rest.replace(/^\s*(…|\.\.\.)?\s*(展开|显示更多|Show more)?/, '');
    if (c.site && c.site.reply) {   // 站点给了回答选择器时优先用它（取最后一个）
      const els = [...document.querySelectorAll(c.site.reply)].filter(visible);
      if (els.length) rest = els[els.length - 1].innerText;
    }
    const text = cleanReply(rest);
    // 回答本身就是一句限制提示（有的站把它显示成 AI 的回复）
    const limited = limitNow() || (text.length < 80 && LIMIT_RE.test(text) ? text.split('\n')[0].slice(0, 60) : '');
    return { ok: true, found: true, text: limited ? '' : text, think: limited ? '' : think, busy: busy(), limited, href: location.href };
  }

  async function handle(msg) {
    if (msg.cmd === 'probe') return probe();
    if (msg.cmd === 'think') return think(!!msg.on);
    if (msg.cmd === 'theme') return theme(msg.target, msg.mode);
    if (msg.cmd === 'send' || (msg.cmd === 'fill' && msg.send)) { sentAt = Date.now(); limitHit = null; }
    if (msg.cmd === 'fill') return fill(msg.text, !!msg.send);
    if (msg.cmd === 'send') return sendNow(msg.text);
    if (msg.cmd === 'reply') return reply(msg.marker, msg.prompt);
    return { ok: false, err: 'unknown cmd' };
  }

  if (parentIsUs) {
    window.addEventListener('message', async ev => {
      if (ev.source !== window.parent || ev.origin !== EXT_ORIGIN) return;
      const msg = ev.data;
      if (!msg || msg.aimv !== 'cmd') return;
      let res;
      try { res = await handle(msg); } catch (e) { res = { ok: false, err: String(e) }; }
      window.parent.postMessage({ aimv: 'res', reqId: msg.reqId, res }, EXT_ORIGIN);
    });
    const hello = () => window.parent.postMessage({ aimv: 'ready', host: location.hostname, href: location.href }, EXT_ORIGIN);
    hello();
    // SPA 换页后再报一次
    let last = location.href;
    setInterval(() => { if (location.href !== last) { last = location.href; hello(); } }, 1500);
  }

  if (window.top === window) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.aimv !== 'cmd') return;
      handle(msg).then(sendResponse, e => sendResponse({ ok: false, err: String(e) }));
      return true;
    });
  }
})();

