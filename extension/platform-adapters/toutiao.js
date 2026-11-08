// 头条号适配器：文章编辑器是 ProseMirror（contenteditable）富文本区，标题是输入框。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setInput, setTextarea, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "toutiao",
    name: "头条号",
    syncMode: "dom",
    fill: async (ctx) => {
      const titleInput = findEditable([
        'input[placeholder*="标题"]',
        'input[class*="title"]',
        'input',
      ]);
      const editor = findEditable([
        '.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea',
      ]);
      if (!editor) return { ok: false, reason: "未找到头条号编辑器（先进入「写文章」页）" };
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
