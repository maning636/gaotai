// 人人都是产品经理适配器：WordPress 后台编辑器，支持经典 TinyMCE（iframe）与 Gutenberg 两种形态。
// Wechatsync 的 woshipm 适配器主要走 API 创建草稿；本适配器按 DOM 注入方式填充编辑器。
// 每个适配器导出 { id, name, syncMode, fill }，并由 index.js 统一注册。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setInput, setTextarea, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "woshipm",
    name: "人人都是产品经理",
    syncMode: "dom",
    fill: async (ctx) => {
      // 1. 填标题
      const titleInput = findEditable([
        'input#title',
        'input[name="post_title"]',
        'input[placeholder*="标题"]',
        'input[class*="title"]',
      ]);

      // 2. 找正文编辑器：优先经典编辑器 textarea#content，其次 contenteditable（Gutenberg），
      //    再回退到 TinyMCE iframe 内的 body。
      let editor = findEditable([
        'textarea#content',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea[class*="editor"]',
      ]);
      if (!editor) {
        const iframe = document.querySelector('iframe#content_ifr, iframe[name="content_ifr"], iframe[class*="mce"]');
        if (iframe && iframe.contentDocument) {
          editor =
            iframe.contentDocument.querySelector('body[contenteditable="true"], body') ||
            iframe.contentDocument.body;
        }
      }
      if (!editor) return { ok: false, reason: "未找到产品经理编辑器（先进入「写文章」页面）" };

      if (titleInput) {
        setInput(titleInput, ctx.title);
        dispatchInput(titleInput);
      }

      // TinyMCE iframe 里的 body 也是 contenteditable，走富文本注入；textarea 走纯文本。
      if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
        setTextarea(editor, ctx.content);
        dispatchInput(editor);
      } else {
        await insertRich(editor, ctx);
      }
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
