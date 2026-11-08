// CSDN 适配器：富文本编辑器（contenteditable），切到 Markdown 标签时是 textarea。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setTextarea, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "csdn",
    name: "CSDN",
    syncMode: "api",
    fill: async (ctx) => {
      const rich = findEditable(['div[contenteditable="true"]', '.editor-toolbar ~ div[contenteditable="true"]']);
      if (rich) {
        await insertRich(rich, ctx);
        return { ok: true };
      }
      const md = findEditable(['textarea[class*="editor"]', 'textarea']);
      if (md) {
        setTextarea(md, ctx.content);
        dispatchInput(md);
        return { ok: true };
      }
      return { ok: false, reason: "未找到 CSDN 编辑器（先进入「写文章」页）" };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
