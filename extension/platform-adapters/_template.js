// 稿台多平台分发 · 适配器模板
//
// 新增平台时复制本文件为 <id>.js，并按注释填充。注册流程：
//   1. 在 extension/manifest.json 的 content_scripts.js 数组里，于
//      "platform-adapters/index.js" 之前插入本文件路径；
//   2. 在 extension/platform-adapters/index.js 的 require 列表里追加一行。
//
// 导出对象字段说明：
//   id        平台唯一标识，须与 src/lib/bridge/platform-registry.ts 的 id 一致。
//   name      平台中文名。
//   syncMode  'api'（调平台官方 API）| 'dom'（DOM 填充）。
//   fill      DOM 填充函数：async (ctx) => { ok, reason?, url? }
//             ctx = { platform, title, content, html, images }。
//             找不到编辑器时返回 { ok:false, reason:"..." }。
//   publish   （可选）API 模式用浏览器 Cookie 调平台 API，后续扩充时实现。

(function (global) {
  const holder =
    (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  // 从 types.js 取共享 DOM 工具（findEditable/insertRich/setTextarea/setInput/dispatchInput/escapeHtml）。
  const { findEditable, insertRich, setTextarea, setInput, dispatchInput, escapeHtml } =
    holder.utils || {};

  const adapter = {
    id: "example", // TODO: 改成平台 id
    name: "示例平台", // TODO: 改成平台中文名
    syncMode: "dom", // 'api' | 'dom'
    fill: async (ctx) => {
      // TODO: 按平台编辑器结构填充；示例：找 contenteditable 并写富文本。
      const editor = findEditable(['div[contenteditable="true"]']);
      if (!editor) return { ok: false, reason: "未找到示例平台编辑器" };
      await insertRich(editor, ctx);
      return { ok: true };
    },
    // publish: async (ctx, runtime) => { ... }, // API 模式，后续实现
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
