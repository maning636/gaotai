/**
 * 授权模块的类型与错误码。
 *
 * 字段名、错误码、token 格式一律以 docs/license-protocol.md 为准，
 * 客户端与服务端分头实现，任何一方改动字段都必须先改协议。
 */

/** 令牌 payload 的全部字段（协议 §3，全部必填）。 */
export interface LicensePayload {
  /** 协议版本，当前固定 1。 */
  v: 1;
  /** 注册码，形如 `GT-7F3K-9QW2-M4XB-8HZP`。 */
  code: string;
  /** 机器码，64 位十六进制。 */
  machine: string;
  /** 签发时间（毫秒）。 */
  issuedAt: number;
  /** 过期时间（毫秒）。 */
  expiresAt: number;
  /** 已授权的功能集合；`core` 恒有。 */
  features: string[];
  /** 套餐层级：`free` 等。 */
  plan: string;
}

/** 缓存到 `<dataDir>/.license/token.json` 的结构（协议 §7）。 */
export interface LicenseCache {
  token: string;
  expiresAt: number;
  machine: string;
  code: string;
  features: string[];
  plan: string;
}

/** 服务端信封的成功分支（协议 §4）。 */
export interface ServerOk<T> {
  ok: true;
  data: T;
}

/** 服务端信封的失败分支（协议 §4）。 */
export interface ServerError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** 服务端统一信封。 */
export type ServerResponse<T> = ServerOk<T> | ServerError;

/** activate / refresh 成功后 data 的结构（协议 §4.1 / §4.2）。 */
export interface ActivationData {
  token: string;
  expiresAt: number;
  features: string[];
  plan: string;
  code: string;
}

/** status 成功后 data 的结构（协议 §4.3）。 */
export interface StatusData {
  activated: boolean;
  revoked: boolean;
  expiresAt: number | null;
  lastSeenAt: number | null;
  plan: string;
}

/**
 * 错误码（与协议 §4 的 HTTP 状态一一对应）。
 *
 * 客户端把这些码原样透传给 UI；HTTP 状态由 API 路由按这张表映射。
 */
export type ErrorCode =
  | "invalid_code" // 404 注册码不存在
  | "code_revoked" // 403 注册码被吊销
  | "device_limit" // 403 设备数超限
  | "machine_mismatch" // 403 机器码不匹配
  | "rate_limited" // 429 限流
  | "bad_request" // 400 请求格式错
  | "bad_contact" // 400 联系方式无效
  | "not_activated" // 403 客户端门禁：未激活
  | "server_not_configured" // 503 客户端：未配置授权服务器
  | "server_unreachable" // 503 客户端：连不上服务器
  | "bad_response"; // 502 客户端：响应不是合法 JSON

/** 错误码 → HTTP 状态。API 路由用它决定返回码。 */
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "bad_request":
    case "bad_contact":
      return 400;
    case "code_revoked":
    case "device_limit":
    case "machine_mismatch":
    case "not_activated":
      return 403;
    case "invalid_code":
      return 404;
    case "rate_limited":
      return 429;
    case "server_not_configured":
    case "server_unreachable":
      return 503;
    case "bad_response":
      return 502;
    default:
      return 500;
  }
}

/** 验签 / 校验失败的原因（token.ts 用）。 */
export type VerifyFailureReason =
  | "bad_format"
  | "bad_signature"
  | "machine_mismatch"
  | "expired";

/** token.ts 的返回值：成功给 payload，失败给结构化原因（不抛裸 Error）。 */
export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: VerifyFailureReason };

/** client.ts 的返回值：成功给 data，失败给错误码 + 中文 message。 */
export type ClientResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

/** gate.ts 对外的授权状态。 */
export type LicenseStatus = "activated" | "expired" | "missing" | "bypass";

/** gate.ts 返回的授权状态快照（联合类型，每种 status 携带不同字段）。 */
export type LicenseState =
  | { status: "activated"; code: string; expiresAt: number; features: string[]; plan: string; machine: string }
  | { status: "expired"; code: string; expiresAt: number; graceUntil: number; features: string[]; plan: string; machine: string }
  | { status: "missing"; machine: string }
  | { status: "bypass"; machine: string };

/** 给 UI 用的可序列化快照（code 打码，不暴露 token）。 */
export interface LicenseSnapshot {
  status: LicenseStatus;
  code: string | null;
  expiresAt: number | null;
  daysLeft: number | null;
  features: string[];
  plan: string | null;
  serverConfigured: boolean;
}

/** activate / refresh 请求体（协议 §4.1 / §4.2）。 */
export interface ActivateRequest {
  code: string;
  machine: string;
  appVersion?: string;
  os?: string;
}

/** refresh 请求体（协议 §4.2）。 */
export interface RefreshRequest {
  code: string;
  machine: string;
  appVersion?: string;
}

/** status 请求体（协议 §4.3）。 */
export interface StatusRequest {
  code: string;
  machine: string;
}
