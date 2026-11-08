// 知乎适配器：文章编辑器是 contenteditable 区域，写入富文本 HTML。
// 每个适配器导出 { id, name, syncMode, fill }，并由 index.js 统一注册。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich } = holder.utils || {};

  const adapter = {
    id: "zhihu",
    name: "知乎",
    syncMode: "api",
    fill: async (ctx) => {
      const editor = findEditable([
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea[class*="editor"]',
      ]);
      if (!editor) return { ok: false, reason: "未找到知乎编辑器（先进入「写文章」页）" };
      await insertRich(editor, ctx);
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
