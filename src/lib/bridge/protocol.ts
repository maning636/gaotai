/**
 * 浏览器扩展桥 · 协议层（纯逻辑，无 I/O）。
 *
 * 稿台桌面版与 Chrome 扩展之间走一条本地 WebSocket 连接：
 * - Electron 主进程起 WS 服务（127.0.0.1:9527，冲突则 +1 直到 9537）；
 * - 浏览器扩展作为客户端连进来，接收 `syncArticle` 后把文章填进对应平台的编辑器；
 * - Next.js 后端子进程作为「后端客户端」连进来，发出同步请求、轮询任务状态。
 *
 * 本文件只做两件事：WebSocket 帧的编解码，以及 JSON-RPC 请求的派发。
 * 不碰 socket、不碰进程——这样协议可以被 Node 测试直接驱动，
 * 也可以被 `electron/ws-bridge.js`（CommonJS 版服务端）镜像复用。
 *
 * 约定：消息一律是 JSON-RPC 2.0 文本帧；服务端→客户端帧不掩码，
 * 客户端→服务端帧必须掩码（WebSocket 规范）。
 */

import { createHash, randomBytes } from "node:crypto";

/** 支持的分发平台。扩展按这份列表展示平台墙。 */
export const PLATFORMS = ["zhihu", "juejin", "csdn", "xiaohongshu", "feishu"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/** 会话角色：浏览器扩展（被推送文章）或后端子进程（发起同步）。 */
export type BridgeRole = "extension" | "backend";

export type BridgeSession = {
  sessionId: string;
  role: BridgeRole;
  clientId: string;
  authenticated: boolean;
};

/** 同步任务的进度状态。 */
export type BridgeTaskStatus = "pending" | "delivered" | "done" | "failed";

export type BridgeTask = {
  taskId: string;
  platform: Platform;
  status: BridgeTaskStatus;
  /** done / failed 时的结果，由扩展回填。 */
  result?: { ok?: boolean; url?: string; reason?: string };
  createdAt: number;
};

/** 一条要发到某个会话的出站消息。 */
export type OutboxMessage = { sessionId: string; payload: string };

/* ------------------------------------------------------------------ *
 * WebSocket 帧编解码
 * ------------------------------------------------------------------ */

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 由客户端握手里的 Sec-WebSocket-Key 计算 Sec-WebSocket-Accept。 */
export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

/**
 * 编码一帧 WebSocket 消息。
 *
 * @param opcode 1=文本 2=二进制 8=关闭 9=ping 10=pong
 * @param payload 负载
 * @param masked 是否掩码。客户端→服务端必须掩码；服务端→客户端不掩码。
 */
export function encodeFrame(opcode: number, payload: Buffer | string, masked = false): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const length = data.length;

  const header = Buffer.alloc(2 + (length >= 126 ? (length >= 65536 ? 8 : 2) : 0) + (masked ? 4 : 0));
  header[0] = 0x80 | (opcode & 0x0f); // FIN=1
  let offset = 2;
  if (length < 126) {
    header[1] = (masked ? 0x80 : 0) | length;
  } else if (length < 65536) {
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }

  let maskKey: Buffer | null = null;
  if (masked) {
    maskKey = randomBytes(4);
    maskKey.copy(header, offset);
  }

  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    body[i] = maskKey ? data[i] ^ maskKey[i % 4] : data[i];
  }
  return Buffer.concat([header, body]);
}

/** 解码出来的一帧。 */
export type DecodedFrame = {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  masked: boolean;
};

/**
 * 增量帧解码器。
 *
 * TCP 是字节流，一条消息可能被拆成多个 chunk，也可能一个 chunk 里挤着好几条。
 * 调用方把每个 chunk push 进来，取出其中完整解码的帧；不完整的留在内部缓冲区。
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: DecodedFrame[] = [];

    for (;;) {
      const frame = this.tryDecodeOne();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  /** 尝试从缓冲区头部解出一帧；数据不足返回 null（不清缓冲区）。 */
  private tryDecodeOne(): DecodedFrame | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      // 超出安全整数范围的帧按超大处理：直接拒绝，避免 read 越界。
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket 帧长度超出安全范围");
      length = Number(big);
      offset = 10;
    }

    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + length) return null;

    const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
    offset += maskLen;
    const payload = Buffer.from(buf.subarray(offset, offset + length));

    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }

    // 消费掉这段。
    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload, masked };
  }
}

/** 把文本帧负载解析成 JSON 对象；解析失败返回 null。 */
export function parseTextFrame(payload: Buffer): unknown | null {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * JSON-RPC 消息构造
 * ------------------------------------------------------------------ */

export function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export function rpcRequest(method: string, params: unknown, id: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export function rpcNotify(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

/* ------------------------------------------------------------------ *
 * 会话与派发核心
 * ------------------------------------------------------------------ */

/** 扩展会话上限。 */
export const MAX_EXTENSION_SESSIONS = 4;

export type BridgeCoreOptions = {
  /** 扩展会话上限，默认 4。 */
  maxExtensionSessions?: number;
};

/**
 * 桥接核心：会话表 + 任务表 + JSON-RPC 派发。
 *
 * 状态全在内存里，进程退出即清空，不需要落盘——桥接的使命是
 * 「把当前这篇文章推到打开的编辑器里」，不承担任何持久化职责。
 */
export class BridgeCore {
  private sessions = new Map<string, BridgeSession>();
  private tasks = new Map<string, BridgeTask>();
  private outbox: OutboxMessage[] = [];
  private _maxExtensionSessions: number;

  constructor(options: BridgeCoreOptions = {}) {
    this._maxExtensionSessions = options.maxExtensionSessions ?? MAX_EXTENSION_SESSIONS;
  }

  /** 扩展会话上限。 */
  get maxExtensionSessions(): number {
    return this._maxExtensionSessions;
  }

  /* -- 会话管理 ------------------------------------------------------ */

  /** 注册一个会话。扩展会话超过上限返回 null；后端会话不占扩展额度。 */
  addSession(input: { role: BridgeRole; clientId: string; token?: string }): BridgeSession | null {
    if (input.role === "extension" && this.extensionCount() >= this._maxExtensionSessions) return null;
    const session: BridgeSession = {
      sessionId: randomBytes(16).toString("hex"),
      role: input.role,
      clientId: input.clientId,
      // token 校验由上层做；这里只记下「是否带 token」，原样透传给扩展自检。
      authenticated: typeof input.token === "string" && input.token.length > 0,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): BridgeSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  extensionCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.role === "extension") n += 1;
    return n;
  }

  hasBackend(): boolean {
    for (const s of this.sessions.values()) if (s.role === "backend") return true;
    return false;
  }

  getClientCount(): number {
    return this.sessions.size;
  }

  /** 取走当前所有出站消息（服务端在每次派发后调用）。 */
  drainOutbox(): OutboxMessage[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /* -- 任务管理 ------------------------------------------------------ */

  getTask(taskId: string): BridgeTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /** 任务总数（用于状态推送）。 */
  getTaskCount(): number {
    return this.tasks.size;
  }

  /* -- 派发 ---------------------------------------------------------- */

  /**
   * 处理一条来自 `sessionId` 的 JSON-RPC 请求，返回要回给**该会话**的响应 JSON；
   * 通知类消息返回 null。跨会话的推送（给扩展的 syncArticle、给后端的 state）
   * 会进 outbox，由服务端统一取走。
   */
  handleMessage(sessionId: string, data: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // 不认识这个会话：给不了有意义的响应，返回一个通用错误。
      return rpcError(null, -32000, "会话不存在或已断开");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return rpcError(null, -32700, "解析错误：请求体不是合法 JSON");
    }

    if (!parsed || typeof parsed !== "object") {
      return rpcError(null, -32600, "无效请求：消息必须是 JSON 对象");
    }
    const msg = parsed as Record<string, unknown>;
    const id = msg.id ?? null;
    const method = typeof msg.method === "string" ? msg.method : "";
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;

    if (!method) {
      return rpcError(id, -32600, "无效请求：缺少 method");
    }

    switch (method) {
      case "hello":
        return this.handleHello(session, id, params);
      case "listPlatforms":
        return rpcResult(id, { platforms: PLATFORMS });
      case "checkAuth":
        return this.handleCheckAuth(session, id, params);
      case "syncArticle":
        return this.handleSyncArticle(session, id, params);
      case "getSyncTask":
        return this.handleGetSyncTask(session, id, params);
      case "syncResult":
        return this.handleSyncResult(session, id, params);
      default:
        return rpcError(id, -32601, `未知方法：${method}`);
    }
  }

  /* -- 方法实现 ------------------------------------------------------ */

  private handleHello(session: BridgeSession, id: unknown, params: Record<string, unknown>): string {
    // 握手：客户端可借此更新 clientId；角色已在 addSession 时定好。
    const clientId = typeof params.clientId === "string" ? params.clientId : session.clientId;
    return rpcResult(id, {
      paired: true,
      sessionId: session.sessionId,
      clientId,
      platforms: PLATFORMS,
      serverTime: Date.now(),
    });
  }

  private handleCheckAuth(session: BridgeSession, id: unknown, params: Record<string, unknown>): string {
    const platform = params.platform;
    if (!isPlatform(platform)) {
      return rpcError(id, -32602, `无效的平台：${String(platform)}`);
    }
    // 服务端不替扩展判断登录态——扩展自己知道。这里回一个占位，
    // 扩展拿到后按自身逻辑复核，需要时再报 checkAuth 的真实结果。
    return rpcResult(id, { platform, authenticated: true });
  }

  private handleSyncArticle(session: BridgeSession, id: unknown, params: Record<string, unknown>): string {
    const platform = params.platform;
    if (!isPlatform(platform)) {
      return rpcError(id, -32602, `无效的平台：${String(platform)}`);
    }
    if (typeof params.title !== "string" || typeof params.content !== "string") {
      return rpcError(id, -32602, "syncArticle 需要 title 与 content（字符串）");
    }

    const taskId = randomBytes(12).toString("hex");
    const task: BridgeTask = {
      taskId,
      platform,
      status: "pending",
      createdAt: Date.now(),
    };
    this.tasks.set(taskId, task);

    const article = {
      taskId,
      platform,
      title: params.title,
      content: params.content,
      html: typeof params.html === "string" ? params.html : params.content,
      images: Array.isArray(params.images) ? params.images : [],
    };

    // 推给所有已连接的扩展会话；一个都没有就置为 failed。
    const extensions = [...this.sessions.entries()].filter(([, s]) => s.role === "extension");
    if (extensions.length === 0) {
      task.status = "failed";
      task.result = { ok: false, reason: "没有已连接的浏览器扩展" };
    } else {
      task.status = "delivered";
      for (const [sessionId] of extensions) {
        this.outbox.push({ sessionId, payload: rpcRequest("syncArticle", article, taskId) });
      }
    }

    // 顺手把最新的连接状态推给后端会话。
    this.pushState();

    // 调用方（后端）拿 taskId 轮询 getSyncTask。
    return rpcResult(id, { ok: true, taskId });
  }

  private handleGetSyncTask(session: BridgeSession, id: unknown, params: Record<string, unknown>): string {
    const taskId = typeof params.taskId === "string" ? params.taskId : "";
    const task = this.tasks.get(taskId);
    if (!task) {
      return rpcError(id, -32001, `任务不存在：${taskId}`);
    }
    return rpcResult(id, { taskId: task.taskId, status: task.status, result: task.result ?? null });
  }

  private handleSyncResult(session: BridgeSession, id: unknown, params: Record<string, unknown>): string {
    const taskId = typeof params.taskId === "string" ? params.taskId : "";
    const task = this.tasks.get(taskId);
    if (!task) {
      return rpcError(id, -32001, `任务不存在：${taskId}`);
    }
    const ok = params.ok === true;
    task.status = ok ? "done" : "failed";
    task.result = {
      ok,
      url: typeof params.url === "string" ? params.url : undefined,
      reason: typeof params.reason === "string" ? params.reason : undefined,
    };
    this.pushState();
    return rpcResult(id, { taskId, status: task.status });
  }

  /**
   * 服务端推送状态变化（连接数、任务状态）。
   * 返回要发给 `sessionId` 的通知 JSON。
   */
  broadcastState(sessionId: string, state: unknown): string {
    return rpcNotify("state", state);
  }

  /** 把当前桥接状态作为通知推给所有后端会话（扩展会话不需要）。 */
  pushState(): void {
    const state = {
      clients: this.getClientCount(),
      extensions: this.extensionCount(),
      tasks: this.tasks.size,
    };
    for (const [sessionId, s] of this.sessions.entries()) {
      if (s.role === "backend") {
        this.outbox.push({ sessionId, payload: this.broadcastState(sessionId, state) });
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 模块级单例（与任务书导出的函数签名对齐）
 * ------------------------------------------------------------------ */

let core: BridgeCore | null = null;

function singleton(): BridgeCore {
  if (!core) core = new BridgeCore();
  return core;
}

/** 模块级派发：委托给单例。服务端与 Next 后端的测试都可复用。 */
export function handleMessage(sessionId: string, data: string): string | null {
  return singleton().handleMessage(sessionId, data);
}

/** 模块级状态推送：委托给单例。 */
export function broadcastState(sessionId: string, state: unknown): string {
  return singleton().broadcastState(sessionId, state);
}

/** 测试用：重建单例。 */
export function resetBridgeCore(): void {
  core = null;
}
