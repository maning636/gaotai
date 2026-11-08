// 抖音图文适配器：图片+文字模式，正文是 contenteditable 区域。
// 注意：抖音图文需先手动上传图片，再填文案；本适配器只负责填标题与正文。
// 每个适配器导出 { id, name, syncMode, fill }，并由 index.js 统一注册。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich, setInput, dispatchInput } = holder.utils || {};

  const adapter = {
    id: "douyin",
    name: "抖音图文",
    syncMode: "dom",
    fill: async (ctx) => {
      // 1. 填文字标题
      const titleInput = findEditable([
        'input[placeholder*="标题"]',
        'input[data-placeholder*="标题"]',
        'input.title',
        'input[class*="title"]',
      ]);
      // 2. 填正文（contenteditable 富文本编辑区）
      const editor = findEditable([
        'div[contenteditable="true"][data-placeholder]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        '[class*="editor"][contenteditable="true"]',
        'textarea[class*="editor"]',
      ]);
      if (!editor) return { ok: false, reason: "未找到抖音图文编辑器（先进入「发布作品/图文」页并上传图片）" };
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
