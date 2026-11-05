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
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

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
    const key = norm(text).slice(0, 20);
    const inp = await waitFor(() => queryFirst(c.input), 4000);
    if (!inp) return { ok: false, err: '没找到输入框（可能未登录或页面改版）' };
    const how = await setText(inp.el, text, c.site && c.site.fill);
    if (!how) return { ok: false, err: '输入框找到了但填不进字', input: inp.sel };
    await sleep(300);
    if (!doSend) return { ok: true, step: 'filled', how, input: inp.sel };
    const btn = await waitFor(() => queryFirst(c.send, enabled), 3000);
    if (btn) btn.el.click();
    else { inp.el.focus(); pressEnter(inp.el); }
    // 发出去的标志：输入框清空（输入框可能被换成新元素，所以重新找）
    const cleared = await waitFor(() => {
      const cur = queryFirst(c.input);
      return !cur || !norm(textOf(cur.el)).includes(key);
    }, 3000);
    // 只在没找到按钮时才按回车；点过按钮就不再补回车，免得发两次
    return {
      ok: !!cleared, step: cleared ? 'sent' : 'not-sent', how, via: btn ? 'button' : 'enter',
      input: inp.sel, send: btn ? btn.sel : null,
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
    if (t.type === 'toggle') {
      const el = [...document.querySelectorAll(t.sel)].find(e => visible(e) && firstLine(e) === t.text);
      if (!el) return { ok: false, err: '没找到「' + t.text + '」开关' };
      const cur = el.getAttribute(t.onAttr) === 'true';
      if (cur !== on) { realClick(el); await sleep(400); }
      return { ok: (el.getAttribute(t.onAttr) === 'true') === on, mode: on ? t.text : '关' };
    }
    if (t.type === 'menu') {
      const want = on ? t.on : t.off;
      const trig = [...document.querySelectorAll(t.trigger)].find(e => visible(e) && (!t.triggerText || [].concat(t.triggerText).some(x => firstLine(e) === x || (e.getAttribute('aria-label') || '') === x || (typeof t.triggerText === 'string' && (e.innerText || '').includes(x)))) && (e.innerText || '').length < 30);
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

  // 强制深色：给整页加反色滤镜，图片和视频再反回来
  function dark(on) {
    let st = document.getElementById('__aimv_dark');
    if (on && !st) {
      st = document.createElement('style');
      st.id = '__aimv_dark';
      st.textContent = `html{filter:invert(.92) hue-rotate(180deg)!important;background:#fff!important}
img,video,canvas,picture,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}`;
      document.documentElement.appendChild(st);
    } else if (!on && st) st.remove();
    return { ok: true, dark: !!on };
  }

  async function handle(msg) {
    if (msg.cmd === 'probe') return probe();
    if (msg.cmd === 'think') return think(!!msg.on);
    if (msg.cmd === 'dark') return dark(!!msg.on);
    if (msg.cmd === 'fill') return fill(msg.text, !!msg.send);
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

