// B站专栏适配器：编辑器以 textarea（Markdown）为主，部分界面是 Quill 富文本。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setTextarea, setInput, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "bilibili",
    name: "B站专栏",
    syncMode: "dom",
    fill: async (ctx) => {
      const titleInput = findEditable([
        'input.title-input',
        'input[placeholder*="标题"]',
        'input[class*="title"]',
      ]);
      const editor = findEditable([
        'textarea[class*="markdown"]',
        'textarea[class*="editor"]',
        'textarea',
        '.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"]',
      ]);
      if (!editor) return { ok: false, reason: "未找到B站专栏编辑器（先进入「写专栏」页）" };
      if (titleInput) {
        if (titleInput.tagName === "TEXTAREA") setTextarea(titleInput, ctx.title);
        else setInput(titleInput, ctx.title);
        dispatchInput(titleInput);
      }
      if (editor.tagName === "TEXTAREA") {
        setTextarea(editor, ctx.content);
        dispatchInput(editor);
      } else {
        await insertRich(editor, ctx);
      }
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})(typeof globalThis !== "undefined" ? globalThis : this);
