// 小红书适配器：图文发布页，标题是输入框、正文是 contenteditable 段落。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setInput, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "xiaohongshu",
    name: "小红书",
    syncMode: "api",
    fill: async (ctx) => {
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
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
