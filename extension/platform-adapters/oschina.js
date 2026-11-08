// 开源中国适配器：Markdown 编辑器（textarea#code 或 CodeMirror 宿主），标题输入框。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, setTextarea, setInput, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "oschina",
    name: "开源中国",
    syncMode: "dom",
    fill: async (ctx) => {
      const titleInput = findEditable([
        'input#title',
        'input[name*="title"]',
        'input[placeholder*="标题"]',
        'input',
      ]);
      const editor = findEditable([
        'textarea#code',
        'textarea[class*="editor"]',
        '.CodeMirror textarea',
        'textarea',
      ]);
      if (!editor) return { ok: false, reason: "未找到开源中国编辑器（先进入「写博客」页）" };
      if (titleInput) {
        setInput(titleInput, ctx.title);
        dispatchInput(titleInput);
      }
      setTextarea(editor, ctx.content);
      dispatchInput(editor);
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})(typeof globalThis !== "undefined" ? globalThis : this);
