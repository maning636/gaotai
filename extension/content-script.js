// 稿台多平台分发 · Content Script
//
// 接收 background 传来的 { platform, title, content, html, images }，
// 按平台适配器把文章填进目标编辑器的 DOM。
//
// 适配器已拆分到 platform-adapters/ 各独立文件，经 IIFE 注册到
// globalThis.__GAOTAI_ADAPTERS__.registry（由 manifest 按序注入：
// types.js → 各适配器 → index.js → 本文件）。本文件只负责查注册表并派发。
//
// 适配器只做「填充」，不做发布——发布动作留给用户自己在页面上点。

// 适配器注册表（由 platform-adapters/index.js 填充）。
const registry =
  (typeof globalThis !== "undefined" &&
    globalThis.__GAOTAI_ADAPTERS__ &&
    globalThis.__GAOTAI_ADAPTERS__.registry) ||
  {};

// 消息入口。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "gaotai:fill") return false;
  const adapter = registry[msg.platform];
  if (!adapter) {
    sendResponse({ ok: false, reason: `不支持的平台：${msg.platform}` });
    return false;
  }
  Promise.resolve(adapter.fill(msg))
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, reason: String(err) }));
  return true; // 异步响应
});
