// 浏览器扩展桥 · Electron 主进程侧（CommonJS，被 main.js require）。
//
// 为什么单独放在 electron/ 而不是 src/lib/bridge/：
// 主进程是 CommonJS，而 src/ 是 TypeScript strict + Next 的 ESM 环境，
// 直接 import TS 文件会引入编译问题。这里是自包含的 CommonJS 实现，
// 只做服务端该做的事——握手、帧循环、会话管理、JSON-RPC 派发。
//
// 与 src/lib/bridge/protocol.ts 保持协议一致（帧格式、JSON-RPC 方法名），
// 但**不共享代码**：两边运行在不同的 Node 进程里，共享反而引入打包复杂度。
//
// 端口策略：优先 GAOTAI_WS_PORT，否则 9527；被占用则 +1，最多到 9537。
// 绑定成功后把实际端口写回 process.env.GAOTAI_WS_PORT，
// 后端子进程经 baseEnv = { ...process.env } 继承，从而读到真实端口。

const net = require("node:net");
const crypto = require("node:crypto");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_PORT = 9527;
const MAX_TRIES = 11;
const MAX_EXTENSION_SESSIONS = 4;

// 支持的分发平台。
const PLATFORMS = ["zhihu", "juejin", "csdn", "xiaohongshu", "feishu"];

/* ── 帧编解码（服务端→客户端不掩码） ──────────────────────────────── */

function computeAcceptKey(secWebSocketKey) {
  return crypto.createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const length = data.length;
  const header = Buffer.alloc(2 + (length >= 126 ? (length >= 65536 ? 8 : 2) : 0));
  header[0] = 0x80 | (opcode & 0x0f);
  if (length < 126) {
    header[1] = length;
  } else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

/* ── 增量帧解码器（客户端→服务端必须掩码） ─────────────────────────── */

function createFrameDecoder() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const frames = [];
      for (;;) {
        const frame = tryDecodeOne();
        if (!frame) break;
        frames.push(frame);
      }
      return frames;
    },
  };

  function tryDecodeOne() {
    if (buffer.length < 2) return null;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("帧长度超出安全范围");
      length = Number(big);
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buffer.length < offset + maskLen + length) return null;
    const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
    offset += maskLen;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload, masked };
  }
}

/* ── JSON-RPC ─────────────────────────────────────────────────────── */

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
function rpcRequest(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

/* ── 桥接服务 ─────────────────────────────────────────────────────── */

let server = null;
let clients = new Map(); // sessionId -> { role, socket, decoder }
let sessions = new Map(); // sessionId -> { role, clientId }
let tasks = new Map(); // taskId -> { taskId, platform, status, result, createdAt }
let currentPort = 0;
let onStateChange = null;

function isPlatform(value) {
  return typeof value === "string" && PLATFORMS.includes(value);
}

function randomId(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function extensionCount() {
  let n = 0;
  for (const s of sessions.values()) if (s.role === "extension") n += 1;
  return n;
}

function emitState() {
  if (!onStateChange) return;
  onStateChange({
    clients: clients.size,
    extensions: extensionCount(),
    tasks: tasks.size,
    port: currentPort,
  });
}

function handleMessage(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) return rpcError(null, -32000, "会话不存在或已断开");

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return rpcError(null, -32700, "解析错误：请求体不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object") return rpcError(null, -32600, "无效请求");
  const msg = parsed;
  const id = msg.id ?? null;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  if (!method) return rpcError(id, -32600, "无效请求：缺少 method");

  switch (method) {
    case "hello":
      return rpcResult(id, {
        paired: true,
        sessionId,
        platforms: PLATFORMS,
        serverTime: Date.now(),
      });
    case "listPlatforms":
      return rpcResult(id, { platforms: PLATFORMS });
    case "checkAuth": {
      if (!isPlatform(params.platform)) return rpcError(id, -32602, "无效的平台");
      return rpcResult(id, { platform: params.platform, authenticated: true });
    }
    case "syncArticle":
      return handleSyncArticle(id, params);
    case "getSyncTask":
      return handleGetSyncTask(id, params);
    case "syncResult":
      return handleSyncResult(id, params);
    default:
      return rpcError(id, -32601, `未知方法：${method}`);
  }
}

function handleSyncArticle(id, params) {
  const platform = params.platform;
  if (!isPlatform(platform)) return rpcError(id, -32602, `无效的平台：${String(platform)}`);
  if (typeof params.title !== "string" || typeof params.content !== "string") {
    return rpcError(id, -32602, "syncArticle 需要 title 与 content（字符串）");
  }
  const taskId = randomId(12);
  const task = { taskId, platform, status: "pending", result: null, createdAt: Date.now() };
  tasks.set(taskId, task);

  const article = {
    taskId,
    platform,
    title: params.title,
    content: params.content,
    html: typeof params.html === "string" ? params.html : params.content,
    images: Array.isArray(params.images) ? params.images : [],
  };

  const extensions = [...sessions.entries()].filter(([, s]) => s.role === "extension");
  if (extensions.length === 0) {
    task.status = "failed";
    task.result = { ok: false, reason: "没有已连接的浏览器扩展" };
  } else {
    task.status = "delivered";
    for (const [sessionId] of extensions) {
      send(sessionId, rpcRequest("syncArticle", article, taskId));
    }
  }
  emitState();
  return rpcResult(id, { ok: true, taskId });
}

function handleGetSyncTask(id, params) {
  const taskId = typeof params.taskId === "string" ? params.taskId : "";
  const task = tasks.get(taskId);
  if (!task) return rpcError(id, -32001, `任务不存在：${taskId}`);
  return rpcResult(id, { taskId: task.taskId, status: task.status, result: task.result });
}

function handleSyncResult(id, params) {
  const taskId = typeof params.taskId === "string" ? params.taskId : "";
  const task = tasks.get(taskId);
  if (!task) return rpcError(id, -32001, `任务不存在：${taskId}`);
  const ok = params.ok === true;
  task.status = ok ? "done" : "failed";
  task.result = {
    ok,
    url: typeof params.url === "string" ? params.url : undefined,
    reason: typeof params.reason === "string" ? params.reason : undefined,
  };
  emitState();
  return rpcResult(id, { taskId, status: task.status });
}

function send(sessionId, payload) {
  const client = clients.get(sessionId);
  if (!client || client.socket.destroyed) return;
  try {
    client.socket.write(encodeFrame(0x1, payload));
  } catch {
    /* 忽略 */
  }
}

function roleFromPath(requestLine) {
  const path = requestLine.split(" ")[1] || "/";
  return path.startsWith("/backend") ? "backend" : "extension";
}

function handleConnection(socket) {
  socket.setNoDelay(true);
  let handshakeBuffer = Buffer.alloc(0);
  let client = null;

  socket.on("data", chunk => {
    if (!client) {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (handshakeBuffer.length > 16 * 1024) socket.destroy();
        return;
      }
      const headerText = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
      const lines = headerText.split("\r\n");
      const requestLine = lines[0] || "";
      if (!/^GET\s+\S+\s+HTTP\/1\.1$/.test(requestLine)) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const headers = {};
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(":");
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      const key = headers["sec-websocket-key"];
      if (!key || (headers["upgrade"] || "").toLowerCase() !== "websocket") {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }

      const role = roleFromPath(requestLine);
      if (role === "extension" && extensionCount() >= MAX_EXTENSION_SESSIONS) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        return;
      }

      const sessionId = randomId(16);
      sessions.set(sessionId, { role, clientId: headers["x-gaotai-client"] || role });

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n` +
          "\r\n",
      );

      client = { sessionId, role, socket, decoder: createFrameDecoder() };
      clients.set(sessionId, client);
      emitState();

      const rest = handshakeBuffer.subarray(headerEnd + 4);
      if (rest.length > 0) consume(client, rest);
      return;
    }
    consume(client, chunk);
  });

  socket.on("error", () => {});
  socket.on("close", () => {
    if (client) {
      clients.delete(client.sessionId);
      sessions.delete(client.sessionId);
      emitState();
    }
  });
}

function consume(client, chunk) {
  let frames;
  try {
    frames = client.decoder.push(chunk);
  } catch {
    client.socket.destroy();
    return;
  }
  for (const frame of frames) {
    if (frame.opcode === 0x8) {
      try {
        client.socket.write(encodeFrame(0x8, frame.payload.subarray(0, 2)));
      } catch {
        /* 忽略 */
      }
      client.socket.end();
      return;
    }
    if (frame.opcode === 0x9) {
      try {
        client.socket.write(encodeFrame(0xa, frame.payload));
      } catch {
        /* 忽略 */
      }
      continue;
    }
    if (frame.opcode === 0xa) continue;
    if (frame.opcode !== 0x1) continue;
    const text = frame.payload.toString("utf8");
    const response = handleMessage(client.sessionId, text);
    if (response) send(client.sessionId, response);
  }
}

/**
 * 启动桥接服务。
 * @param {number} [preferredPort] 首选端口，默认读环境变量或 9527。
 * @param {(state: object) => void} [onChange] 状态变化回调。
 * @returns {Promise<{port: number, close: () => void}>}
 */
function startWsBridge(preferredPort, onChange) {
  onStateChange = onChange || null;
  const base = Number(preferredPort || process.env.GAOTAI_WS_PORT || DEFAULT_PORT);
  const start = Number.isInteger(base) && base > 0 ? base : DEFAULT_PORT;

  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    server = srv;
    let attempt = 0;
    let settled = false;

    // error / listening 只注册一次。EADDRINUSE 时内部自增端口再 listen，
    // 避免每个冲突端口都叠加一个 error 监听器导致 MaxListenersExceededWarning。
    srv.on("error", err => {
      if (settled) return;
      if (err && err.code === "EADDRINUSE") {
        attempt += 1;
        if (attempt >= MAX_TRIES) {
          settled = true;
          reject(new Error(`端口 ${start}–${start + MAX_TRIES - 1} 均被占用，无法启动 WS 桥`));
        } else {
          srv.listen(start + attempt, "127.0.0.1");
        }
      } else {
        settled = true;
        reject(err);
      }
    });
    srv.on("listening", () => {
      const addr = srv.address();
      currentPort = addr && typeof addr === "object" ? addr.port : start + attempt;
      process.env.GAOTAI_WS_PORT = String(currentPort);
      emitState();
      resolve({ port: currentPort, close: stopWsBridge });
    });

    srv.on("connection", handleConnection);
    srv.listen(start + attempt, "127.0.0.1");
  });
}

/** 停止桥接服务并清空会话/任务。 */
function stopWsBridge() {
  for (const client of clients.values()) {
    try {
      client.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      /* 忽略 */
    }
    client.socket.destroy();
  }
  clients.clear();
  sessions.clear();
  if (server) {
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
    server = null;
  }
  delete process.env.GAOTAI_WS_PORT;
  currentPort = 0;
  emitState();
}

/** 是否在运行。 */
function isWsBridgeRunning() {
  return server !== null && server.listening;
}

/** 当前端口。 */
function getWsBridgePort() {
  return currentPort;
}

module.exports = {
  startWsBridge,
  stopWsBridge,
  isWsBridgeRunning,
  getWsBridgePort,
  // 供测试/诊断用：
  _internal: {
    handleMessage,
    encodeFrame,
    computeAcceptKey,
    isPlatform,
    PLATFORMS,
    getSessionCount: () => sessions.size,
    getExtensionCount: extensionCount,
    getTask: taskId => tasks.get(taskId) || null,
  },
};
