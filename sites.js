// 各站配置：网址、识别用的域名、输入框和发送按钮的候选选择器（按顺序试，取第一个可见的）。
// 站点改版导致广播失效时，只需改这里。改完到 chrome://extensions 点本扩展的刷新按钮。
// newChat：/clear 时打开的「新对话」网址（不写就用 url）。
// think：深度思考开关怎么点。toggle = 一个开关按钮；menu = 点开模型菜单选一项。没写的站要在栏里手动选。
// reply（可选）：回答元素的选择器，场景模式读回答时取最后一个；不写就用通用办法（取刚发出的消息后面的文字）。
// 通用兜底（GENERIC）会在站点自己的候选都没命中时再试。
self.AIMV_SITES = [
  {
    id: 'claude', name: 'Claude', url: 'https://claude.ai/new',
    hosts: ['claude.ai'],
    input: ['div[data-testid="chat-input"][contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]'],
    send: ['button[data-testid="chat-input-send"]', 'button[aria-label="Send message"]', 'button[aria-label="发送消息"]']
  },
  {
    id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    input: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]'],
    send: ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[type="submit"][aria-label="发送"]', 'button[type="submit"][aria-label*="Send"]']
  },
  {
    id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app',
    hosts: ['gemini.google.com'],
    input: ['div.ql-editor[role="textbox"]', 'rich-textarea div[contenteditable="true"]'],
    send: ['button.send-button', 'button[aria-label="发送"]', 'button[aria-label*="Send"]']
  },
  {
    id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/',
    hosts: ['chat.deepseek.com'],
    input: ['textarea#chat-input', 'textarea[placeholder*="DeepSeek"]', 'textarea'],
    send: ['div[role="button"].ds-button--primary.ds-button--filled.ds-button--circle', 'div[role="button"].ds-button--primary.ds-button--filled'],
    think: { type: 'toggle', sel: 'div.ds-toggle-button', text: '深度思考', onAttr: 'aria-pressed' }
  },
  {
    id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/',
    hosts: ['www.doubao.com', 'doubao.com'],
    input: ['[data-testid="chat_input_input"] [contenteditable="true"]', 'textarea[data-testid="chat_input_input"]', 'div.tiptap[contenteditable="true"]'],
    send: ['button[data-testid="chat_input_send_button"]', 'button#flow-end-msg-send']
  },
  {
    id: 'qwen', name: '千问', url: 'https://www.qianwen.com/',
    hosts: ['www.qianwen.com', 'qianwen.com', 'www.tongyi.com', 'tongyi.aliyun.com', 'chat.qwen.ai'],
    input: ['div[data-slate-editor="true"][contenteditable="true"]', 'textarea'],
    send: ['button[aria-label="发送消息"]', 'button[aria-label*="发送"]'],
    fill: 'paste',  // Slate 编辑器：execCommand 改了 DOM 但编辑器不认，只认粘贴
    think: { type: 'menu', trigger: 'button[data-state]', triggerText: ['快速', '思考研究'], item: '[role="menuitemcheckbox"]', on: '思考研究', off: '快速' }  // 输入框下方的「快速 ▾」
  },
  {
    id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/',
    hosts: ['www.kimi.com', 'kimi.com', 'kimi.moonshot.cn'],
    input: ['div.chat-input-editor[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
    send: ['div.send-button-container'],
    think: { type: 'menu', trigger: '.current-model', item: '[role="menuitemradio"]', on: 'K3.1 Pro', off: '快速' }
  },
  {
    id: 'yuanbao', name: '元宝', url: 'https://yuanbao.tencent.com/chat',
    hosts: ['yuanbao.tencent.com'],
    input: ['.chat-command-editor-specail .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]'],
    // 不可点时 class 里带 SendButton_disabled__xxx（CSS Modules 哈希后缀会变，所以按子串排除）
    send: ['#yuanbao-send-btn:not([class*="disabled"])', '[aria-label="发送"]:not([class*="disabled"])'],
    think: { type: 'menu', trigger: 'button[aria-label="切换模型"]', item: '[role="menuitemradio"]', on: '深度思考', off: '快速回答' }
  }
];

self.AIMV_GENERIC = {
  input: ['textarea:not([readonly])', 'div[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
  send: ['button[type="submit"]', 'button[aria-label*="Send" i]', 'button[aria-label*="发送"]', 'button[data-testid*="send" i]']
};

self.AIMV_findSite = function (hostname) {
  return self.AIMV_SITES.find(s => s.hosts.some(h => hostname === h || hostname.endsWith('.' + h))) || null;
};
