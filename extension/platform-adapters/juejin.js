// 掘金适配器：Markdown 编辑器是 textarea（CodeMirror/ByteMD 底层），写入 Markdown。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, setTextarea, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "juejin",
    name: "掘金",
    syncMode: "api",
    fill: async (ctx) => {
      const editor = findEditable([
        'textarea[class*="editor"]',
        'textarea[data-role="editor"]',
        'textarea[class*="markdown"]',
        'textarea',
      ]);
      if (!editor) return { ok: false, reason: "未找到掘金 Markdown 编辑器" };
      setTextarea(editor, ctx.content);
      dispatchInput(editor);
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
