/**
 * 浏览器扩展桥 · 后端客户端（Next.js 子进程用）。
 *
 * 后端子进程是独立的 Node 进程，它既不是 WS 服务端也不是扩展。
 * 它要「把文章推到扩展里」的方式是：自己作为 WS **客户端**连到
 * Electron 主进程起的服务端（`ws://127.0.0.1:<GAOTAI_WS_PORT>`），
 * 然后发 JSON-RPC 请求 `syncArticle`，扩展收到后回 `syncResult`。
 *
 * 端口从 `process.env.GAOTAI_WS_PORT` 读：Electron 启动 WS 服务端后写入，
 * 并随 `baseEnv` 传给本进程。开发态没有该变量时，回退探测 9527 系列端口。
 *
 * 本模块是单例：多个 API 请求共享一条连接，连接断了自动重连。
 * 所有方法幂等且不抛错——桥接失败只影响多平台分发这一条链路，
 * 不能拖垮正文/封面等主流程。
 */

import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  encodeFrame,
  FrameDecoder,
  parseTextFrame,
  rpcRequest,
} from "./protocol";

/** 与 ws-server.ts 的端口策略保持一致。 */
const DEFAULT_PORT = 9527;
const MAX_TRIES = 11;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

/**
 * 后端桥客户端。
 *
 * 持有一条到服务端的连接。请求-响应按 JSON-RPC `id` 配对；
 * 服务端推送（通知，无 id）通过 `onNotify` 回调交给调用方。
 */
export class BackendBridgeClient {
  private socket: Socket | null = null;
  private pending = new Map<string | number, Pending>();
  private decoder = new FrameDecoder();
  private sessionId: string | null = null;
  private handshakeBuffer = Buffer.alloc(0);
  private nextId = 1;
  private connected = false;
  private closedByUs = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private onNotify: ((method: string, params: unknown) => void) | null = null;

  constructor(private port: number = DEFAULT_PORT) {}

  setNotifyHandler(handler: (method: string, params: unknown) => void): void {
    this.onNotify = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPort(): number {
    return this.port;
  }

  /** 连接服务端。若已在连接中则先关闭旧连接。 */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.disconnectSocket();
      this.closedByUs = false;
      this.decoder = new FrameDecoder();
      this.handshakeBuffer = Buffer.alloc(0);

      const socket = connect({ host: "127.0.0.1", port: this.port });
      this.socket = socket;

      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`连接 WS 桥失败：127.0.0.1:${this.port}`));
        }
      }, 2000);

      socket.on("connect", () => {
        // 握手：GET /backend + Sec-WebSocket-Key。
        const key = randomKey();
        socket.write(
          `GET /backend HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${this.port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n` +
            `X-Gaotai-Client: backend\r\n` +
            `\r\n`,
        );
      });

      socket.on("data", (chunk) => {
        if (!this.connected) {
          this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
          const headerEnd = this.handshakeBuffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const headerText = this.handshakeBuffer.subarray(0, headerEnd).toString("utf8");
          const statusLine = headerText.split("\r\n")[0] ?? "";
          if (!/101\s+Switching Protocols/.test(statusLine)) {
            settled = true;
            socket.destroy();
            reject(new Error(`WS 桥握手被拒绝：${statusLine}`));
            return;
          }
          // 握手成功。
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.connected = true;
            // 连上后立刻 hello 握手，拿到 sessionId。
            this.sendRequest("hello", { clientId: "backend" })
              .then((res) => {
                const r = res as { sessionId?: string };
                if (r && typeof r.sessionId === "string") this.sessionId = r.sessionId;
              })
              .catch(() => {
                /* hello 失败不影响使用 */
              });
            resolve();
          }
          const rest = this.handshakeBuffer.subarray(headerEnd + 4);
          if (rest.length > 0) this.consume(rest);
          return;
        }
        this.consume(chunk);
      });

      socket.on("error", () => {
        /* 统一由 close 处理 */
      });

      socket.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.sessionId = null;
        this.failAllPending(new Error("连接已断开"));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`连接 WS 桥失败：127.0.0.1:${this.port}`));
          return;
        }
        if (wasConnected && !this.closedByUs) this.scheduleReconnect();
      });
    });
  }

  /** 关闭连接（不再重连）。 */
  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.disconnectSocket();
  }

  /**
   * 发一个 JSON-RPC 请求并等待响应。
   * 未连接时先自动连接；失败则抛错，由调用方决定如何降级。
   */
  async call(method: string, params: unknown): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }
    return this.sendRequest(method, params);
  }

  /** 发一个带 taskId 的同步请求。 */
  async syncArticle(params: { platform: string; title: string; content: string; html?: string; images?: string[] }): Promise<{ ok: boolean; taskId: string }> {
    const res = (await this.call("syncArticle", params)) as { ok?: boolean; taskId?: string };
    if (!res || res.ok !== true || typeof res.taskId !== "string") {
      throw new Error("syncArticle 响应缺少 taskId");
    }
    return { ok: true, taskId: res.taskId };
  }

  /** 查询一个同步任务的状态。 */
  async getTask(taskId: string): Promise<{ taskId: string; status: string; result: unknown }> {
    const res = (await this.call("getSyncTask", { taskId })) as {
      taskId?: string;
      status?: string;
      result?: unknown;
    };
    if (!res || typeof res.status !== "string") throw new Error("getSyncTask 响应缺少 status");
    return { taskId: res.taskId ?? taskId, status: res.status, result: res.result ?? null };
  }

  /* -- 内部实现 ------------------------------------------------------ */

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error("WS 桥未连接"));
        return;
      }
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC 请求超时：${method}`));
      }, 8000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.socket.write(encodeFrame(0x1, rpcRequest(method, params, id), true));
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private consume(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.disconnectSocket();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        this.disconnectSocket();
        return;
      }
      if (frame.opcode === 0x9) {
        try {
          this.socket?.write(encodeFrame(0xa, frame.payload, true));
        } catch {
          /* 忽略 */
        }
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode !== 0x1) continue;

      const parsed = parseTextFrame(frame.payload);
      if (!parsed || typeof parsed !== "object") continue;
      const msg = parsed as Record<string, unknown>;

      // 通知（无 id）：交给回调。
      if (msg.id === undefined || msg.id === null) {
        if (this.onNotify && typeof msg.method === "string") {
          this.onNotify(msg.method, msg.params);
        }
        continue;
      }

      const id = msg.id as string | number;
      const pending = this.pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (msg.error) {
        const errMsg = (msg.error as { message?: string }).message ?? "JSON-RPC 错误";
        pending.reject(new Error(errMsg));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private disconnectSocket(): void {
    this.failAllPending(new Error("连接已关闭"));
    if (this.socket) {
      this.socket.removeAllListeners();
      try {
        this.socket.destroy();
      } catch {
        /* 忽略 */
      }
      this.socket = null;
    }
    this.connected = false;
    this.sessionId = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUs) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        /* 重连失败由下次请求或定时器再试 */
      });
    }, 2000);
  }
}

function randomKey(): string {
  // 16 字节随机 → base64，符合 Sec-WebSocket-Key 要求。
  return randomBytes(16).toString("base64");
}

/* ------------------------------------------------------------------ *
 * 模块级单例
 * ------------------------------------------------------------------ */

let client: BackendBridgeClient | null = null;
let configuredPort: number | null = null;

/** 读取端口：优先环境变量，否则探测 9527 系列。 */
function resolvePort(): number {
  if (configuredPort) return configuredPort;
  const env = Number(process.env.GAOTAI_WS_PORT || "");
  if (Number.isInteger(env) && env > 0 && env < 65536) {
    configuredPort = env;
    return env;
  }
  // 没读到环境变量（开发态直接跑 next dev），按默认端口策略探测。
  configuredPort = DEFAULT_PORT;
  return DEFAULT_PORT;
}

/** 重置已解析的端口（测试用）。 */
export function resetBackendBridge(): void {
  if (client) {
    client.close();
    client = null;
  }
  configuredPort = null;
}

/** 取（或创建）后端桥客户端单例。 */
export function getBackendBridge(): BackendBridgeClient {
  if (!client) client = new BackendBridgeClient(resolvePort());
  return client;
}

export { DEFAULT_PORT, MAX_TRIES };
