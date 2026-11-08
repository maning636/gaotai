// 豆瓣适配器：日记/话题编辑页（topic/create?subtype=note），正文使用 Draft.js 编辑器。
// Wechatsync 的豆瓣适配器主要走 API 发布；本适配器按 DOM 注入方式填充编辑器。
// 每个适配器导出 { id, name, syncMode, fill }，并由 index.js 统一注册。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setInput, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "douban",
    name: "豆瓣",
    syncMode: "dom",
    fill: async (ctx) => {
      // 1. 填标题
      const titleInput = findEditable([
        'input[name="note_title"]',
        'input[placeholder*="标题"]',
        'input[class*="title"]',
      ]);
      // 2. 填正文（Draft.js 的 contenteditable 区域，或回退到 textarea）
      const editor = findEditable([
        'div[contenteditable="true"][class*="note"]',
        'div[contenteditable="true"]',
        'textarea[name="note_content"]',
        '.note-editor textarea',
        'textarea[class*="editor"]',
      ]);
      if (!editor) return { ok: false, reason: "未找到豆瓣编辑器（先进入「写日记/发起话题」页）" };
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
