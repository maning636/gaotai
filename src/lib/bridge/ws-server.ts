/**
 * 浏览器扩展桥 · WS 服务端（Node 内置 net，不依赖 ws 包）。
 *
 * 桌面版场景：Chrome 扩展连到 `ws://127.0.0.1:<port>` 上，等待服务端推送
 * `syncArticle`；后端子进程也以 WS 客户端身份连进来，用来发同步请求。
 *
 * 端口策略：优先 `preferredPort`（默认 9527），被占用就 +1，最多试到 9537；
 * 全部被占则抛错。绑定成功后把实际端口写入 `process.env.GAOTAI_WS_PORT`，
 * 这样后端子进程（经 Electron 的 `baseEnv = {...process.env}` 继承）能读到。
 *
 * 协议：手写 RFC 6455 握手 + 帧解析/编码。客户端→服务端帧必须掩码，
 * 服务端→客户端帧不掩码。仅支持文本帧（opcode=1），ping/pong/close 按规范应答。
 *
 * 角色由握手 URL 的路径区分：`/extension`（浏览器扩展）与 `/backend`（后端子进程）。
 * 扩展会话上限由 BridgeCore 强制（默认 4）。
 */

import { createServer, type Server, type Socket } from "node:net";
import {
  BridgeCore,
  computeAcceptKey,
  encodeFrame,
  FrameDecoder,
  MAX_EXTENSION_SESSIONS,
  parseTextFrame,
  resetBridgeCore,
  type BridgeRole,
} from "./protocol";

/** 默认端口与最大尝试次数（9527 → 9537，共 11 个候选）。 */
export const DEFAULT_WS_PORT = 9527;
export const MAX_PORT_TRIES = 11;

/** 握手路径 → 角色。未知路径视为扩展（兼容旧客户端只连裸地址）。 */
function roleFromPath(requestLine: string): BridgeRole {
  const path = requestLine.split(" ")[1] ?? "/";
  if (path.startsWith("/backend")) return "backend";
  return "extension";
}

type Connected = {
  sessionId: string;
  role: BridgeRole;
  socket: Socket;
  decoder: FrameDecoder;
};

/**
 * 桥接服务器。
 *
 * 一个实例持有自己的 TCP server、会话表与协议核心。测试可分别实例化多个，
 * 生产用模块级单例（见文件底部）。
 */
export class BridgeServer {
  private server: Server | null = null;
  private clients = new Map<string, Connected>();
  private core: BridgeCore;
  private onStateChange: ((state: { clients: number; extensions: number; tasks: number }) => void) | null = null;

  constructor(options: { maxExtensionSessions?: number; onStateChange?: (state: { clients: number; extensions: number; tasks: number }) => void } = {}) {
    this.core = new BridgeCore({ maxExtensionSessions: options.maxExtensionSessions ?? MAX_EXTENSION_SESSIONS });
    this.onStateChange = options.onStateChange ?? null;
  }

  /** 绑定并开始监听。返回实际端口。 */
  start(preferredPort = DEFAULT_WS_PORT): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      this.server = server;

      let attempt = 0;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      // error / listening 只注册一次。EADDRINUSE 时内部自增端口再 listen，
      // 不会再叠加新的 error 监听器（否则每个冲突端口都加一个，触发
      // MaxListenersExceededWarning，且重试越多泄漏越多）。
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        if (err.code === "EADDRINUSE") {
          attempt += 1;
          if (attempt >= MAX_PORT_TRIES) {
            settled = true;
            if (timer) clearTimeout(timer);
            reject(new Error(`端口 ${preferredPort}–${preferredPort + MAX_PORT_TRIES - 1} 均被占用，无法启动 WS 桥`));
          } else {
            server.listen(preferredPort + attempt, "127.0.0.1");
          }
        } else {
          settled = true;
          if (timer) clearTimeout(timer);
          reject(err);
        }
      });

      server.on("listening", () => {
        const addr = server.address();
        const boundPort = addr && typeof addr === "object" ? addr.port : preferredPort + attempt;
        process.env.GAOTAI_WS_PORT = String(boundPort);
        settled = true;
        if (timer) clearTimeout(timer);
        this.emitState();
        resolve(boundPort);
      });

      server.on("connection", (socket) => this.handleConnection(socket));

      // 兜底：长时间没 listening 就拒绝。
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("WS 桥启动超时"));
        }
      }, 3000);
      timer.unref();

      server.listen(preferredPort + attempt, "127.0.0.1");
    });
  }

  /** 是否在监听。 */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** 当前端口；未启动返回 0。 */
  getPort(): number {
    if (!this.server || !this.server.listening) return 0;
    const addr = this.server.address();
    return addr && typeof addr === "object" ? addr.port : 0;
  }

  /** 当前连接的会话数。 */
  getClientCount(): number {
    return this.clients.size;
  }

  /** 当前连接的扩展会话数。 */
  getExtensionCount(): number {
    return this.core.extensionCount();
  }

  /** 会话表（用于测试与状态查询）。 */
  getCore(): BridgeCore {
    return this.core;
  }

  /** 向指定会话推送一条通知（如 state）。 */
  send(sessionId: string, payload: string): void {
    const client = this.clients.get(sessionId);
    if (!client || client.socket.destroyed) return;
    try {
      client.socket.write(encodeFrame(0x1, payload, false));
    } catch {
      /* 忽略：连接可能已断开 */
    }
  }

  /** 向所有扩展会话广播一条消息。 */
  broadcastToExtensions(payload: string): void {
    for (const client of this.clients.values()) {
      if (client.role === "extension") this.send(client.sessionId, payload);
    }
  }

  /** 向所有后端会话广播一条消息。 */
  broadcastToBackends(payload: string): void {
    for (const client of this.clients.values()) {
      if (client.role === "backend") this.send(client.sessionId, payload);
    }
  }

  /** 关闭服务端与所有客户端。 */
  close(): void {
    for (const client of this.clients.values()) {
      try {
        client.socket.write(encodeFrame(0x8, Buffer.alloc(0), false));
      } catch {
        /* 忽略 */
      }
      client.socket.destroy();
    }
    this.clients.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* 忽略 */
      }
      this.server = null;
    }
    delete process.env.GAOTAI_WS_PORT;
    this.emitState();
  }

  /** 处理一条入站连接：握手 → 帧循环。 */
  private handleConnection(socket: Socket): void {
    socket.setNoDelay(true);
    let handshakeBuffer = Buffer.alloc(0);
    let client: Connected | null = null;

    const onData = (chunk: Buffer) => {
      if (!client) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (handshakeBuffer.length > 16 * 1024) socket.destroy();
          return;
        }

        const headerText = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
        const lines = headerText.split("\r\n");
        const requestLine = lines[0] ?? "";
        if (!/^GET\s+\S+\s+HTTP\/1\.1$/.test(requestLine)) {
          socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }

        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(":");
          if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }

        const key = headers["sec-websocket-key"];
        if (!key || headers["upgrade"]?.toLowerCase() !== "websocket") {
          socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }

        // 角色由 URL 路径决定；扩展会话数超上限则拒绝。
        const role = roleFromPath(requestLine);
        if (role === "extension" && this.core.extensionCount() >= this.core.maxExtensionSessions) {
          socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          return;
        }

        const session = this.core.addSession({ role, clientId: headers["x-gaotai-client"] ?? role });
        if (!session) {
          socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          return;
        }

        const accept = computeAcceptKey(key);
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            "\r\n",
        );

        client = { sessionId: session.sessionId, role, socket, decoder: new FrameDecoder() };
        this.clients.set(session.sessionId, client);
        this.emitState();

        const rest = handshakeBuffer.subarray(headerEnd + 4);
        if (rest.length > 0) this.consume(client, rest);
        return;
      }

      this.consume(client, chunk);
    };

    socket.on("data", onData);
    socket.on("error", () => {
      /* 错误统一由 close 清理 */
    });
    socket.on("close", () => {
      if (client) {
        this.clients.delete(client.sessionId);
        this.core.removeSession(client.sessionId);
        this.emitState();
      }
    });
  }

  /** 帧消费：文本帧进协议核心，ping/pong/close 按规范应答。 */
  private consume(client: Connected, chunk: Buffer): void {
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
          client.socket.write(encodeFrame(0x8, frame.payload.subarray(0, 2), false));
        } catch {
          /* 忽略 */
        }
        client.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        try {
          client.socket.write(encodeFrame(0xa, frame.payload, false));
        } catch {
          /* 忽略 */
        }
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode !== 0x1) continue; // 只支持文本帧

      const text = frame.payload.toString("utf8");
      const parsed = parseTextFrame(frame.payload);
      const response = this.core.handleMessage(client.sessionId, text);
      if (response) this.send(client.sessionId, response);

      // 协议核心在派发时把给扩展/后端的推送塞进 outbox，这里统一送出。
      for (const out of this.core.drainOutbox()) {
        if (out.sessionId === client.sessionId) continue;
        this.send(out.sessionId, out.payload);
      }
      if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).method) {
        this.emitState();
      }
    }
  }

  private emitState(): void {
    if (!this.onStateChange) return;
    this.onStateChange({
      clients: this.getClientCount(),
      extensions: this.getExtensionCount(),
      tasks: this.core.getTaskCount(),
    });
  }
}

/* ------------------------------------------------------------------ *
 * 模块级单例（与任务书导出的函数签名对齐）
 * ------------------------------------------------------------------ */

let singletonServer: BridgeServer | null = null;

/**
 * 启动默认桥接服务器。重复调用会先关闭旧实例。
 * 返回 `{ port, close }`。
 */
export async function startWsServer(preferredPort = DEFAULT_WS_PORT): Promise<{ port: number; close: () => void }> {
  if (singletonServer) {
    try {
      singletonServer.close();
    } catch {
      /* 忽略 */
    }
    singletonServer = null;
  }
  const server = new BridgeServer();
  const port = await server.start(preferredPort);
  singletonServer = server;
  return { port, close: () => server.close() };
}

/** 停止默认桥接服务器。 */
export function stopWsServer(): void {
  if (singletonServer) {
    singletonServer.close();
    singletonServer = null;
  }
  resetBridgeCore();
}

/** 取默认桥接服务器（未启动返回 null）。 */
export function getActiveBridge(): BridgeServer | null {
  return singletonServer;
}
