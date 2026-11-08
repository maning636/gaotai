// 百家号适配器：富文本编辑器可能在主文档 contenteditable，也可能嵌在同源 iframe 内。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setInput, setTextarea, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "baijiahao",
    name: "百家号",
    syncMode: "dom",
    fill: async (ctx) => {
      const titleInput = findEditable([
        'input[placeholder*="标题"]',
        'input[class*="title"]',
        'input',
      ]);
      let editor = findEditable([
        'div[contenteditable="true"]',
        'textarea[class*="editor"]',
        'textarea',
      ]);
      if (!editor) {
        // 编辑器嵌在同源 iframe 内（contentDocument 仅在同源时可读）。
        const iframe = document.querySelector("iframe");
        const doc = iframe && iframe.contentDocument;
        editor = doc && doc.querySelector('div[contenteditable="true"], textarea');
      }
      if (!editor) return { ok: false, reason: "未找到百家号编辑器（先进入「发布文章」页）" };
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
