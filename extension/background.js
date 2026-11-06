// 稿台多平台分发 · Service Worker
//
// 职责：
// 1. 连到稿台桌面版的本地 WS 桥（ws://127.0.0.1:<port>），断线自动重连；
// 2. 收到服务端推送的 syncArticle 时，把文章交给活动标签页里的 content-script 填入编辑器；
// 3. 维护连接状态，供 popup 查询。
//
// 注意：Chrome MV3 的 service worker 会在空闲时被回收，所有状态都放
// chrome.storage.local 而不是内存变量，重活后能恢复。

const WS_PORT = 9527; // 与 Electron 主进程默认一致；冲突时服务端会 +1，这里靠重连兜底。
const RECONNECT_MS = 2000;

let socket = null;
let reconnectTimer = null;
let handshakeDone = false;

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

function connect() {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* 忽略 */
    }
    socket = null;
  }
  handshakeDone = false;

  try {
    socket = new WebSocket(`ws://127.0.0.1:${WS_PORT}/extension`);
  } catch (err) {
    void setState({ connected: false, port: WS_PORT, sessionId: null, error: String(err) });
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    // 握手：hello。
    send({
      jsonrpc: "2.0",
      id: "hello",
      method: "hello",
      params: { clientId: "extension" },
    });
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.id === "hello") {
      handshakeDone = true;
      const sessionId = msg.result && msg.result.sessionId ? msg.result.sessionId : null;
      void setState({ connected: true, port: WS_PORT, sessionId });
      return;
    }

    if (msg.method === "syncArticle" && msg.params) {
      void handleSyncArticle(msg.params);
      return;
    }
    if (msg.method === "state") {
      // 服务端状态通知：只更新端口展示。
      void setState({ connected: true, port: WS_PORT, sessionId: (await getState()).sessionId });
      return;
    }
  };

  socket.onclose = () => {
    socket = null;
    handshakeDone = false;
    void setState({ connected: false, port: WS_PORT, sessionId: null });
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose 会跟着来，统一在那里重连。
  };
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
