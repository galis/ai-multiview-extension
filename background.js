// 后台：
//  - 点工具栏图标打开并排页；
//  - 给并排页所在的那个标签页加 session 规则：只对它里面的子框架去掉 X-Frame-Options / CSP；
//  - 多窗口模式：开窗口平铺、给这些窗口转发广播指令。
const PAGE = chrome.runtime.getURL('multiview.html');

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: PAGE }));

function ruleFor(tabId) {
  return {
    id: tabId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' }
      ]
    },
    condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] }
  };
}

async function registerTab(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId], addRules: [ruleFor(tabId)] });
}
async function unregisterTab(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
}

chrome.tabs.onRemoved.addListener(tabId => unregisterTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && !info.url.startsWith(PAGE)) unregisterTab(tabId);
});

// ---------- 多窗口模式 ----------
async function getWins() {
  return (await chrome.storage.session.get('wins')).wins || [];
}
async function setWins(w) { await chrome.storage.session.set({ wins: w }); }

async function tileWindows(panes, area) {
  // 关掉上次开的
  for (const w of await getWins()) await chrome.windows.remove(w.windowId).catch(() => {});
  const n = panes.length;
  const rows = n > 4 ? 2 : 1;
  const cols = Math.ceil(n / rows);
  const W = Math.floor(area.width / cols), H = Math.floor(area.height / rows);
  const wins = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const win = await chrome.windows.create({
      url: panes[i].url, type: 'popup', focused: false,
      left: area.left + c * W, top: area.top + r * H, width: W, height: H
    });
    wins.push({ paneId: panes[i].id, windowId: win.id, tabId: win.tabs[0].id });
  }
  await setWins(wins);
  return wins;
}

async function sendToWindow(paneId, msg) {
  const w = (await getWins()).find(x => x.paneId === paneId);
  if (!w) return { ok: false, err: '这一栏没有对应窗口（先点"平铺成窗口"）' };
  try {
    await chrome.windows.update(w.windowId, { focused: true });
    return await chrome.tabs.sendMessage(w.tabId, msg, { frameId: 0 });
  } catch (e) {
    return { ok: false, err: '窗口不在或页面还没加载好：' + e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'registerTab':
        await registerTab(sender.tab.id);
        return { ok: true, tabId: sender.tab.id };
      case 'tileWindows':
        return { ok: true, wins: await tileWindows(msg.panes, msg.area) };
      case 'closeWindows':
        for (const w of await getWins()) await chrome.windows.remove(w.windowId).catch(() => {});
        await setWins([]);
        return { ok: true };
      case 'sendToWindow':
        return sendToWindow(msg.paneId, msg.cmd);
      case 'popout': {
        const w = await chrome.windows.create({ url: PAGE + '#' + msg.hash, focused: true, state: 'maximized' });
        if (sender.tab) chrome.tabs.remove(sender.tab.id).catch(() => {});
        return { ok: true, windowId: w.id };
      }
      case 'focusTab':
        await chrome.windows.update(sender.tab.windowId, { focused: true });
        return { ok: true };
    }
    return { ok: false, err: 'unknown' };
  })().then(sendResponse, e => sendResponse({ ok: false, err: String(e) }));
  return true;
});
