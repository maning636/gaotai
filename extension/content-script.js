// 稿台多平台分发 · Content Script
//
// 接收 background 传来的 { platform, title, content, html, images }，
// 按平台适配器把文章填进目标编辑器的 DOM。
//
// 每个平台一个适配器函数；找不到编辑器时返回 { ok: false, reason }。
// 适配器只做「填充」，不做发布——发布动作留给用户自己在页面上点。

// 平台适配器表：platform -> async (ctx) => { ok, reason?, url? }
const adapters = {
  // 知乎：文章编辑器是 contenteditable 区域。写入富文本 HTML。
  zhihu: async (ctx) => {
    const editor = findEditable([
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[class*="editor"]',
    ]);
    if (!editor) return { ok: false, reason: "未找到知乎编辑器（先进入「写文章」页）" };
    await insertRich(editor, ctx);
    return { ok: true };
  },

  // 掘金：Markdown 编辑器是 textarea（CodeMirror/ByteMD 底层）。写入 Markdown。
  juejin: async (ctx) => {
    const editor = findEditable([
      'textarea[class*="editor"]',
      'textarea[data-role="editor"]',
      'textarea[class*="markdown"]',
      'textarea',
    ]);
    if (!editor) return { ok: false, reason: "未找到掘金 Markdown 编辑器" };
    setTextarea(editor, ctx.content);
    dispatchInput(editor);
    return { ok: true };
  },

  // CSDN：富文本编辑器（contenteditable），切到 Markdown 标签时是 textarea。
  csdn: async (ctx) => {
    const rich = findEditable(['div[contenteditable="true"]', '.editor-toolbar ~ div[contenteditable="true"]']);
    if (rich) {
      await insertRich(rich, ctx);
      return { ok: true };
    }
    const md = findEditable(['textarea[class*="editor"]', 'textarea']);
    if (md) {
      setTextarea(md, ctx.content);
      dispatchInput(md);
      return { ok: true };
    }
    return { ok: false, reason: "未找到 CSDN 编辑器（先进入「写文章」页）" };
  },

  // 小红书：图文发布页，标题是输入框、正文是 contenteditable 段落。
  xiaohongshu: async (ctx) => {
    const titleInput = findEditable([
      'input[placeholder*="标题"]',
      'input[placeholder*="标题"]',
      'input[class*="title"]',
      'input',
    ]);
    const bodyEditor = findEditable([
      'div[contenteditable="true"][data-placeholder*="正文"]',
      'div[contenteditable="true"]',
    ]);
    if (!titleInput && !bodyEditor) {
      return { ok: false, reason: "未找到小红书发布页（先点「发布笔记」）" };
    }
    if (titleInput) {
      setInput(titleInput, ctx.title);
      dispatchInput(titleInput);
    }
    if (bodyEditor) {
      await insertRich(bodyEditor, ctx);
    }
    return { ok: true };
  },

  // 飞书：文档编辑器是 contenteditable（ProseMirror 底层）。
  feishu: async (ctx) => {
    const editor = findEditable([
      'div[contenteditable="true"][data-block-id]',
      'div[contenteditable="true"]',
    ]);
    if (!editor) return { ok: false, reason: "未找到飞书文档编辑器（先打开一篇文档）" };
    await insertRich(editor, ctx);
    return { ok: true };
  },
};

// 找第一个匹配的选择器且可见的元素。
function findEditable(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

// 把 HTML 写入 contenteditable，并触发 input 事件（富文本编辑器才认这个）。
async function insertRich(editor, ctx) {
  if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
    setTextarea(editor, ctx.content);
    dispatchInput(editor);
    return;
  }
  editor.focus();
  editor.innerHTML = ctx.html || `<p>${escapeHtml(ctx.content)}</p>`;
  dispatchInput(editor);
}

function setTextarea(el, value) {
  el.value = value;
}

function setInput(el, value) {
  el.value = value;
}

// 现代编辑器大多监听 input 事件；React 还要求原生 setter + 事件。
function dispatchInput(el) {
  try {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, el.value);
  } catch {
    /* 原生 setter 不可用时跳过 */
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 消息入口。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "gaotai:fill") return false;
  const adapter = adapters[msg.platform];
  if (!adapter) {
    sendResponse({ ok: false, reason: `不支持的平台：${msg.platform}` });
    return false;
  }
  Promise.resolve(adapter(msg))
    .then(result => sendResponse(result))
    .catch(err => sendResponse({ ok: false, reason: String(err) }));
  return true; // 异步响应
});
