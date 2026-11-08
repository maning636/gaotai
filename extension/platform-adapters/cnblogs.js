// 博客园适配器：Markdown 编辑器（textarea 或 CodeMirror 宿主），标题输入框。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, setTextarea, setInput, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "cnblogs",
    name: "博客园",
    syncMode: "dom",
    fill: async (ctx) => {
      const titleInput = findEditable([
        '#Editor_Edit_ASPxBlogTitle',
        'input[name*="title"]',
        'input[placeholder*="标题"]',
        'input',
      ]);
      const editor = findEditable([
        'textarea#Editor_Edit_EditorBody',
        'textarea[class*="editor"]',
        '.CodeMirror textarea',
        'textarea',
      ]);
      if (!editor) return { ok: false, reason: "未找到博客园编辑器（先进入「写随笔」页）" };
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
