// 飞书适配器：文档编辑器是 contenteditable（ProseMirror 底层）。
// 飞书是稿台自有平台（注册表未收录），单独保留以兼容现有链路。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich } = holder.utils || {};

  const adapter = {
    id: "feishu",
    name: "飞书",
    syncMode: "dom",
    fill: async (ctx) => {
      const editor = findEditable([
        'div[contenteditable="true"][data-block-id]',
        'div[contenteditable="true"]',
      ]);
      if (!editor) return { ok: false, reason: "未找到飞书文档编辑器（先打开一篇文档）" };
      await insertRich(editor, ctx);
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
