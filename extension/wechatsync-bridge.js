// Wechatsync 桥接模块
//
// 检测页面中是否存在 Wechatsync 扩展注入的 API，存在则通过 window.postMessage
// 把同步请求转发给 Wechatsync（API 模式，比 DOM 填充更可靠）；不存在则返回失败，
// content-script.js 会自动回退到稿台自带的 DOM 填充适配器。
//
// Wechatsync 的 content script（api.ts）监听 window message 事件，接收 JSON 字符串：
//   { method: "getAccounts" }                          → 查询已登录平台
//   { method: "addTask", task: { post, accounts } }    → 提交同步任务
// 返回也是 window.postMessage，带 eventID 匹配请求，callReturn=true。
//
// 本模块用 IIFE 挂到 globalThis.__GAOTAI_WS_BRIDGE__，同时 module.exports 供 Node 测试。

(function (global) {
  const holder =
    (global && global.__GAOTAI_WS_BRIDGE__) ||
    (global && (global.__GAOTAI_WS_BRIDGE__ = {}));

  // Wechatsync content script 用 JSON.stringify(postMessage) 通信，callReturn=true 标记返回。
  // 我们发请求时带唯一 eventID，监听匹配的返回。

  let seq = 0;

  // 检测 Wechatsync 扩展是否在页面中注入了 API。
  // 方式：发一个 getAccounts 请求，如果 2 秒内收到响应则认为存在。
  function detect() {
    return new Promise((resolve) => {
      const id = `gaotai-detect-${++seq}-${Date.now()}`;
      let done = false;

      const handler = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg && msg.eventID === id) {
            window.removeEventListener("message", handler);
            done = true;
            resolve(true);
          }
        } catch {
          /* 非 JSON 消息，忽略 */
        }
      };

      window.addEventListener("message", handler);

      // Wechatsync api.ts 监听 window message，method=getAccounts 返回已登录平台列表。
      window.postMessage(
        JSON.stringify({ method: "getAccounts", eventID: id }),
        "*",
      );

      // 2 秒超时——没有 Wechatsync 扩展就不等了。
      setTimeout(() => {
        if (!done) {
          window.removeEventListener("message", handler);
          resolve(false);
        }
      }, 2000);
    });
  }

  // 查询 Wechatsync 已登录的平台列表，返回 [{ type, title, ... }]。
  function getAccounts() {
    return new Promise((resolve) => {
      const id = `gaotai-accounts-${++seq}-${Date.now()}`;
      let done = false;

      const handler = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg && msg.eventID === id) {
            window.removeEventListener("message", handler);
            done = true;
            resolve(msg.result || []);
          }
        } catch {
          /* 忽略 */
        }
      };

      window.addEventListener("message", handler);
      window.postMessage(
        JSON.stringify({ method: "getAccounts", eventID: id }),
        "*",
      );

      setTimeout(() => {
        if (!done) {
          window.removeEventListener("message", handler);
          resolve([]);
        }
      }, 3000);
    });
  }

  // 提交一篇文章到指定平台，返回 { ok, url?, reason? }。
  // ctx = { platform, title, content, html, images }
  // Wechatsync 的 addTask 需要 task.post 和 task.accounts：
  //   post = { title, content(html), markdown, thumb }
  //   accounts = [{ type: platformId }]
  async function publish(ctx) {
    const accounts = await getAccounts();
    const matched = accounts.filter((a) => a.type === ctx.platform);

    if (matched.length === 0) {
      return {
        ok: false,
        reason: `Wechatsync 未登录平台 ${ctx.platform}，或该平台不在 Wechatsync 支持列表中`,
      };
    }

    // HTML → Markdown 简易转换（Wechatsync 内部也会转，但我们提供 markdown 帮助它）
    let markdown = ctx.content || "";
    if (ctx.html) {
      markdown = ctx.html
        .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n")
        .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n")
        .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n")
        .replace(/<p[^>]*>(.*?)<\/p>/gis, "$1\n\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li[^>]*>(.*?)<\/li>/gis, "- $1\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const task = {
      post: {
        title: ctx.title || "",
        content: ctx.html || ctx.content || "",
        markdown,
        thumb: ctx.images && ctx.images[0] ? ctx.images[0] : undefined,
      },
      accounts: matched.map((a) => ({ type: a.type })),
    };

    return new Promise((resolve) => {
      const id = `gaotai-publish-${++seq}-${Date.now()}`;
      let done = false;

      // 监听任务更新和完成消息。
      const handler = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (!msg || !msg.method) return;

          // taskUpdate 消息：检查是否所有账户都完成了。
          if (msg.method === "taskUpdate" && msg.task && msg.task.accounts) {
            const accountsList = msg.task.accounts;
            const target = accountsList.find((a) => a.type === ctx.platform);
            if (target) {
              if (target.status === "done") {
                window.removeEventListener("message", handler);
                done = true;
                resolve({
                  ok: true,
                  url: (target.editResp && target.editResp.draftLink) || undefined,
                });
              } else if (target.status === "failed") {
                window.removeEventListener("message", handler);
                done = true;
                resolve({
                  ok: false,
                  reason: target.error || "Wechatsync 发布失败",
                });
              }
            }
          }
        } catch {
          /* 忽略 */
        }
      };

      window.addEventListener("message", handler);

      // 提交任务。
      window.postMessage(
        JSON.stringify({ method: "addTask", task, eventID: id }),
        "*",
      );

      // 60 秒超时。
      setTimeout(() => {
        if (!done) {
          window.removeEventListener("message", handler);
          resolve({
            ok: false,
            reason: "Wechatsync 发布超时（60 秒未返回结果）",
          });
        }
      }, 60000);
    });
  }

  holder.detect = detect;
  holder.getAccounts = getAccounts;
  holder.publish = publish;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { detect, getAccounts, publish };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
