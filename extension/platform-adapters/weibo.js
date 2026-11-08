// 微博适配器：文章发布页的正文是 contenteditable 富文本区，标题是输入框。
// 只在微博网页上下文执行，仅用浏览器原生 DOM API。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setInput, setTextarea, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "weibo",
    name: "微博",
    syncMode: "dom",
    fill: async (ctx) => {
      const titleInput = findEditable([
        'input[placeholder*="标题"]',
        'input[class*="title"]',
        'input[name*="title"]',
      ]);
      const editor = findEditable([
        'div[contenteditable="true"][data-testid*="editor"]',
        'div[contenteditable="true"]',
        'textarea[class*="editor"]',
        'textarea',
      ]);
      if (!editor) return { ok: false, reason: "未找到微博编辑器（先进入「写文章」页）" };
      if (titleInput) {
        if (titleInput.tagName === "TEXTAREA") setTextarea(titleInput, ctx.title);
        else setInput(titleInput, ctx.title);
        dispatchInput(titleInput);
      }
      await insertRich(editor, ctx);
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})(typeof globalThis !== "undefined" ? globalThis : this);
