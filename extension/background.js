// 稿台多平台分发 · Service Worker
//
// 职责：
// 1. 连到稿台桌面版的本地 WS 桥（ws://127.0.0.1:<port>），断线自动重连；
// 2. 收到服务端推送的 syncArticle 时，把文章交给活动标签页里的 content-script 填入编辑器；
// 3. 维护连接状态，供 popup 查询。
//
// 注意：Chrome MV3 的 service worker 会在空闲时被回收，所有状态都放
// chrome.storage.local 而不是内存变量，重活后能恢复。

// 端口范围与 Electron 主进程一致：优先 9527，被占用时服务端最多 +10。
// 只写死一个端口的话，用户机器上 9527 一旦被别的程序占了，
// 插件就永远连不上，而界面上只会显示「没连上」——排查起来毫无线索。
const PORT_CANDIDATES = Array.from({ length: 11 }, (_, i) => 9527 + i);
const RECONNECT_MS = 2000;

let socket = null;
let reconnectTimer = null;
let handshakeDone = false;
// 上一次成功的端口，下次优先试它：多数时候端口不会变。
let preferredPort = 9527;

// 当前推送任务的等待器：taskId -> { resolve, reject }。
const pendingSyncs = new Map();

async function setState(state) {
  await chrome.storage.local.set({ bridgeState: { ...state, updatedAt: Date.now() } });
}

async function getState() {
  const { bridgeState } = await chrome.storage.local.get("bridgeState");
  return bridgeState || { connected: false, port: 0, sessionId: null };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

/**
 * 依次尝试端口，直到握手成功。
 *
 * 为什么不是「连上 9527 就完事」：主进程端口被占用时会自动 +1（见
 * electron/ws-bridge.js），而用户机器上 9527 被别的程序占着是常见情况。
 * 只试一个端口的话，插件会一直停在「未连接」，界面上又没有任何线索。
 */
async function connect() {
  teardownSocket();

  const ports = [preferredPort, ...PORT_CANDIDATES].filter(
    (port, index, list) => list.indexOf(port) === index,
  );

  for (const port of ports) {
    const ok = await tryPort(port);
    if (ok) return;
  }

  void setState({ connected: false, port: 0, sessionId: null, error: "没找到稿台的桥接服务" });
  scheduleReconnect();
}

/** 断开旧连接并清掉定时器，避免多个 socket 同时存在。 */
function teardownSocket() {
  if (!socket) return;
  const old = socket;
  socket = null;
  try {
    old.close();
  } catch {
    /* 忽略 */
  }
}

/**
 * 试一个端口：握手成功返回 true；连不上或超时返回 false，由上层换下一个。
 *
 * 注意 onmessage 里不能直接 await（回调不是 async 函数），
 * 需要读状态就在里面调 .then——这个文件之前因为这一处 `await` 是语法错误，
 * Chrome 直接拒绝加载 service worker，表现是「插件装了但永远连不上」。
 */
function tryPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    } catch {
      resolve(false);
      return;
    }
    socket = ws;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      resolve(false);
    }, 2500);

    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: "hello", method: "hello", params: { clientId: "extension" } }));
      } catch {
        /* 忽略 */
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.id === "hello") {
        handshakeDone = true;
        preferredPort = port;
        const sessionId = msg.result && msg.result.sessionId ? msg.result.sessionId : null;
        void setState({ connected: true, port, sessionId });
        settle(true);
        return;
      }

      if (msg.method === "syncArticle" && msg.params) {
        void handleSyncArticle(msg.params);
        return;
      }
      if (msg.method === "state") {
        // 服务端状态通知：只更新端口展示。
        void getState().then((previous) =>
          setState({ connected: true, port, sessionId: previous.sessionId || null }),
        );
      }
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      handshakeDone = false;
      void setState({ connected: false, port: 0, sessionId: null });
      // 已经连通过再断，说明稿台还在，只是连接掉了——重连。
      // 还在探测阶段时由 settle(false) 让上层换下一个端口。
      if (settled) scheduleReconnect();
      settle(false);
    };

    ws.onerror = () => {
      // onclose 会跟着来，统一在那里处理。
    };
  });
}


function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

// 收到 syncArticle：找到当前活动标签页，向它的 content-script 发填充指令。
async function handleSyncArticle(article) {
  const taskId = article.taskId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      replyResult(taskId, { ok: false, reason: "没有活动标签页" });
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "gaotai:fill",
      platform: article.platform,
      title: article.title,
      content: article.content,
      html: article.html,
      images: article.images || [],
    });
    if (response && response.ok) {
      replyResult(taskId, { ok: true, url: tab.url || undefined });
    } else {
      replyResult(taskId, { ok: false, reason: (response && response.reason) || "填充失败" });
    }
  } catch (err) {
    replyResult(taskId, { ok: false, reason: `无法向页面注入内容：${String(err)}` });
  }
}

function replyResult(taskId, result) {
  send({
    jsonrpc: "2.0",
    id: `sync-result-${taskId}`,
    method: "syncResult",
    params: { taskId, ...result },
  });
}

// popup 查询连接状态。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "gaotai:get-status") {
    void getState().then(state => sendResponse({ type: "gaotai:status", ...state }));
    return true; // 异步响应
  }
  return false;
});

// 安装/启动即连接。
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
connect();
