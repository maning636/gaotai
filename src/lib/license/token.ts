import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { LicensePayload, VerifyResult } from "./types";
import { licensePublicKey } from "./public-key";

/**
 * gt1 令牌编解码 + Ed25519 验签（协议 §3）。
 *
 * 格式：`gt1.<base64url(payloadJSON)>.<base64url(signature)>`
 * - `signingInput = "gt1." + payloadB64`
 * - `signature = base64url(Ed25519_sign(privateKey, signingInput))`
 *
 * 客户端用内置公钥验签，**必须**校验 `v === 1`、`machine` 与本机一致、`expiresAt > now`。
 * 任一条不满足返回结构化失败原因（`bad_format` / `bad_signature` / `machine_mismatch` / `expired`），
 * 不抛裸 Error——调用方靠返回值分支，不靠 try/catch 吞错。
 *
 * 纯函数：不碰 IO（不读缓存、不写缓存、不跑 PowerShell）。
 */

/** token 前缀。 */
const TOKEN_PREFIX = "gt1.";

/**
 * base64url 编码（用于 payload 与 signature）。
 *
 * Node 的 Buffer.toString("base64url") 即标准 base64url（无填充），
 * 与协议一致——JWT 生态也都用这个。
 */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/** base64url 解码（容忍有/无填充）。 */
function b64urlDecode(input: string): Buffer {
  // base64url → base64：换字符 + 补填充
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * 用私钥签发一个 gt1 token。
 *
 * 仅供测试用：生产环境 token 由授权服务器签发，客户端只有公钥。
 * 测试里生成真实 Ed25519 密钥对，用私钥签 token，再用客户端公钥验——
 * 覆盖篡改 payload、篡改签名、错机器、过期四种场景。
 *
 * @param payload 完整 payload（v/code/machine/issuedAt/expiresAt/features/plan）
 * @param privateKeyPem Ed25519 私钥 PEM
 */
export function signToken(payload: LicensePayload, privateKeyPem: string): string {
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = TOKEN_PREFIX + payloadB64;
  const sig = sign(null, Buffer.from(signingInput), createPrivateKey(privateKeyPem));
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * 校验并解析一个 gt1 token。
 *
 * 步骤：
 * 1. 格式：必须 `gt1.` 开头、三段、payload 与 signature 都能 base64url 解。
 * 2. 验签：`crypto.verify(null, signingInput, publicKey, sigBuffer)`。
 * 3. payload 字段：`v === 1`、`code`/`machine` 是字符串、`expiresAt` 是数字。
 * 4. 机器码：与传入的 `expectedMachine` 严格相等。
 * 5. 过期：`expiresAt > Date.now()`。
 *
 * 失败原因见 `VerifyResult`；成功给 `LicensePayload`。
 *
 * @param token 待校验的 token 字符串
 * @param expectedMachine 本机机器码（64 位 hex）
 * @param publicKeyPem 可选，默认用内置公钥（测试可传自己的）
 */
export function verifyToken(
  token: string,
  expectedMachine: string,
  publicKeyPem?: string,
): VerifyResult {
  // 1. 格式校验
  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, reason: "bad_format" };
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  const dotIdx = rest.lastIndexOf(".");
  if (dotIdx <= 0) {
    return { ok: false, reason: "bad_format" };
  }
  const payloadB64 = rest.slice(0, dotIdx);
  const sigB64 = rest.slice(dotIdx + 1);
  if (!payloadB64 || !sigB64) {
    return { ok: false, reason: "bad_format" };
  }

  let payloadBuf: Buffer;
  let sigBuf: Buffer;
  try {
    payloadBuf = b64urlDecode(payloadB64);
    sigBuf = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: "bad_format" };
  }
  if (payloadBuf.length === 0 || sigBuf.length === 0) {
    return { ok: false, reason: "bad_format" };
  }

  // 解析 payload JSON
  let payload: LicensePayload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf8")) as LicensePayload;
  } catch {
    return { ok: false, reason: "bad_format" };
  }

  // payload 字段完整性
  if (
    payload.v !== 1 ||
    typeof payload.code !== "string" ||
    typeof payload.machine !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number" ||
    !Array.isArray(payload.features) ||
    typeof payload.plan !== "string"
  ) {
    return { ok: false, reason: "bad_format" };
  }

  // 2. 验签：Ed25519，signingInput = "gt1." + payloadB64
  const signingInput = TOKEN_PREFIX + payloadB64;
  const pem = publicKeyPem ?? licensePublicKey();
  let pubkey;
  try {
    pubkey = createPublicKey(pem);
  } catch {
    // 公钥本身坏了（配置问题），当 bad_format 处理
    return { ok: false, reason: "bad_format" };
  }
  const valid = verify(null, Buffer.from(signingInput), pubkey, sigBuf);
  if (!valid) {
    return { ok: false, reason: "bad_signature" };
  }

  // 4. 机器码：严格相等
  if (payload.machine !== expectedMachine) {
    return { ok: false, reason: "machine_mismatch" };
  }

  // 5. 过期
  if (payload.expiresAt <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}

/** 导出 b64urlDecode 供测试构造篡改 token 用。 */
export { b64urlDecode, b64url };
