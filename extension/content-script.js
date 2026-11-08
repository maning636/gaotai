// 稿台多平台分发 · Content Script
//
// 接收 background 传来的 { platform, title, content, html, images }，
// 按以下优先级处理：
//   1. Wechatsync API 模式（更可靠）—— 如果页面中存在 Wechatsync 扩展，
//      通过 window.postMessage 把文章交给 Wechatsync 的 API 适配器发布。
//   2. DOM 填充模式（回退）—— 用稿台自带的平台适配器填充编辑器 DOM。
//
// 适配器已拆分到 platform-adapters/ 各独立文件，经 IIFE 注册到
// globalThis.__GAOTAI_ADAPTERS__.registry（由 manifest 按序注入：
// types.js → 各适配器 → index.js → 本文件）。本文件只负责查注册表并派发。
//
// Wechatsync 桥接模块在 wechatsync-bridge.js 中，挂到 globalThis.__GAOTAI_WS_BRIDGE__。

// 适配器注册表（由 platform-adapters/index.js 填充）。
const registry =
  (typeof globalThis !== "undefined" &&
    globalThis.__GAOTAI_ADAPTERS__ &&
    globalThis.__GAOTAI_ADAPTERS__.registry) ||
  {};

// Wechatsync 桥接模块（由 wechatsync-bridge.js 填充）。
const wsBridge =
  (typeof globalThis !== "undefined" && globalThis.__GAOTAI_WS_BRIDGE__) || null;

// 消息入口。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "gaotai:fill") return false;

  const ctx = {
    platform: msg.platform,
    title: msg.title,
    content: msg.content,
    html: msg.html,
    images: msg.images || [],
  };

  // 1. 先尝试 Wechatsync API 模式（更可靠，走 Cookie 调平台 API）。
  if (wsBridge && typeof wsBridge.publish === "function") {
    wsBridge
      .publish(ctx)
      .then((result) => {
        if (result && result.ok) {
          sendResponse(result);
          return;
        }
        // Wechatsync 失败（未安装/未登录/不支持），回退到 DOM 填充。
        fallbackToDom(ctx, sendResponse, result ? result.reason : undefined);
      })
      .catch(() => {
        fallbackToDom(ctx, sendResponse, "Wechatsync 桥接异常");
      });
    return true; // 异步响应
  }

  // 没有 Wechatsync 桥接模块，直接 DOM 填充。
  fallbackToDom(ctx, sendResponse);
  return true;
});

// DOM 填充回退：用稿台自带适配器填充编辑器。
function fallbackToDom(ctx, sendResponse, wsReason) {
  const adapter = registry[ctx.platform];
  if (!adapter) {
    sendResponse({
      ok: false,
      reason: wsReason
        ? `${wsReason}；且不支持的平台：${ctx.platform}`
        : `不支持的平台：${ctx.platform}`,
    });
    return;
  }
  Promise.resolve(adapter.fill(ctx))
    .then((result) => {
      // DOM 填充成功时，如果有 Wechatsync 失败原因，附在 warning 里。
      if (result && result.ok && wsReason) {
        sendResponse({ ...result, warning: `Wechatsync 不可用（${wsReason}），已回退到 DOM 填充` });
      } else {
        sendResponse(result);
      }
    })
    .catch((err) =>
      sendResponse({ ok: false, reason: String(err) }),
    );
}
