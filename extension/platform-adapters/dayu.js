// 大鱼号适配器：mp.dayu.com 文章创建页，正文是 contenteditable 区域（阿里系编辑器）。
// 每个适配器导出 { id, name, syncMode, fill }，并由 index.js 统一注册。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setInput, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "dayu",
    name: "大鱼号",
    syncMode: "dom",
    fill: async (ctx) => {
      // 1. 填标题
      const titleInput = findEditable([
        '[data-role="title"] input',
        'input[placeholder*="标题"]',
        'input.title',
        'input[name*="title"]',
        'input[class*="title"]',
      ]);
      // 2. 填正文（contenteditable 富文本编辑区）
      const editor = findEditable([
        'div[contenteditable="true"][data-role="editor"]',
        '[data-role="editor"][contenteditable="true"]',
        'div[contenteditable="true"][class*="editor"]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea[class*="editor"]',
      ]);
      if (!editor) return { ok: false, reason: "未找到大鱼号编辑器（先进入「写文章」页面）" };
      if (titleInput) {
        setInput(titleInput, ctx.title);
        dispatchInput(titleInput);
      }
      await insertRich(editor, ctx);
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
