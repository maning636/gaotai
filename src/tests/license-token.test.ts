import { generateKeyPairSync } from "node:crypto";
import { assertEqual, assertTrue, assertMatch, suite } from "./harness";
import { signToken, verifyToken, b64url, b64urlDecode } from "../lib/license/token";
import type { LicensePayload } from "../lib/license/types";

/**
 * gt1 令牌验签（协议 §3）。
 *
 * 测试自己生成真实 Ed25519 密钥对，用私钥签、用公钥验，
 * 覆盖正常、篡改 payload、篡改签名、错机器、过期、乱格式等场景。
 * 不依赖任何外网或仓库里的私钥文件。
 */

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const MACHINE = "a".repeat(64);
const OTHER_MACHINE = "b".repeat(64);

/** 构造一份合法 payload，调用方可覆盖字段。 */
function makePayload(over: Partial<LicensePayload> = {}): LicensePayload {
  const now = Date.now();
  return {
    v: 1,
    code: "GT-7F3K-9QW2-M4XB-8HZP",
    machine: MACHINE,
    issuedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    features: ["core", "skills", "prompts"],
    plan: "free",
    ...over,
  };
}

/** 把任意对象编码成 gt1 三段式（不验签，用于构造格式校验场景的 token）。 */
function encodeToken(payloadObj: unknown): string {
  return `gt1.${b64url(JSON.stringify(payloadObj))}.${b64url("dummy")}`;
}

suite("gt1 令牌验签", ({ test }) => {
  test("正常 token 验签通过，payload 一致", () => {
    const payload = makePayload();
    const token = signToken(payload, privatePem);
    const result = verifyToken(token, MACHINE, publicPem);
    assertTrue(result.ok, "合法 token 应当验签通过");
    assertEqual(result.ok, true);
    if (result.ok) {
      assertEqual(result.payload.code, payload.code);
      assertEqual(result.payload.machine, MACHINE);
      assertEqual(result.payload.v, 1);
      assertEqual(result.payload.features, payload.features);
      assertEqual(result.payload.plan, payload.plan);
      assertEqual(result.payload.expiresAt, payload.expiresAt);
    }
  });

  test("篡改 payload 后重新 base64url 拼回 → bad_signature", () => {
    const payload = makePayload();
    // 先签一个合法 token，再篡改 payload 段（签名段不变）
    const token = signToken(payload, privatePem);
    const tampered = { ...payload, expiresAt: payload.expiresAt + 365 * 24 * 60 * 60 * 1000 };
    const payloadB64 = b64url(JSON.stringify(tampered));
    // 取原 token 的签名段
    const sigB64 = token.split(".")[2];
    const forged = `gt1.${payloadB64}.${sigB64}`;
    const result = verifyToken(forged, MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_signature");
  });

  test("篡改 features 段 → bad_signature", () => {
    const payload = makePayload();
    const token = signToken(payload, privatePem);
    const tampered = { ...payload, features: ["core", "premium", "everything"] };
    const payloadB64 = b64url(JSON.stringify(tampered));
    const sigB64 = token.split(".")[2];
    const forged = `gt1.${payloadB64}.${sigB64}`;
    const result = verifyToken(forged, MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_signature");
  });

  test("篡改签名最后一个字节 → bad_signature", () => {
    const payload = makePayload();
    const token = signToken(payload, privatePem);
    const parts = token.split(".");
    const sigBuf = b64urlDecode(parts[2]);
    // 改最后一个字节
    const tamperedSig = Buffer.from(sigBuf);
    tamperedSig[tamperedSig.length - 1] ^= 0xff;
    const forged = `gt1.${parts[1]}.${b64url(tamperedSig)}`;
    const result = verifyToken(forged, MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_signature");
  });

  test("别的机器码 → machine_mismatch", () => {
    const payload = makePayload();
    const token = signToken(payload, privatePem);
    const result = verifyToken(token, OTHER_MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "machine_mismatch");
  });

  test("expiresAt 已过 → expired", () => {
    const past = Date.now() - 10_000;
    const payload = makePayload({ issuedAt: past - 1000, expiresAt: past });
    const token = signToken(payload, privatePem);
    const result = verifyToken(token, MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "expired");
  });

  test("空串 → bad_format", () => {
    const result = verifyToken("", MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_format");
  });

  test("只有前缀 gt1. → bad_format", () => {
    const result = verifyToken("gt1.", MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_format");
  });

  test("两段式 abc.def → bad_format", () => {
    const result = verifyToken("abc.def", MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_format");
  });

  test("三段但 payload 非法 base64 → bad_format", () => {
    // payload 段含 !@# 不是合法 base64url
    const result = verifyToken("gt1.!!@@##.abc", MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_format");
  });

  test("v=2 的 payload → bad_format", () => {
    const payload = makePayload({ v: 2 as unknown as 1 });
    const token = signToken(payload, privatePem);
    const result = verifyToken(token, MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_format");
  });

  test("签名段是合法 base64 但长度不对 → bad_signature 或 bad_format，不得抛异常", () => {
    const payload = makePayload();
    const token = signToken(payload, privatePem);
    const parts = token.split(".");
    // 用一段合法但长度不对的签名（Ed25519 签名固定 64 字节，这里给 16 字节）
    const shortSig = b64url(Buffer.alloc(16, 0x41));
    const forged = `gt1.${parts[1]}.${shortSig}`;
    const result = verifyToken(forged, MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) {
      assertTrue(
        result.reason === "bad_signature" || result.reason === "bad_format",
        `期望 bad_signature 或 bad_format，实际：${result.reason}`,
      );
    }
  });

  test("payload 是合法 JSON 但缺字段 → bad_format", () => {
    const result = verifyToken(encodeToken({ v: 1 }), MACHINE, publicPem);
    assertEqual(result.ok, false);
    if (!result.ok) assertEqual(result.reason, "bad_format");
  });

  test("合法 token 的机器码匹配 64 位 hex 格式", () => {
    const payload = makePayload();
    const token = signToken(payload, privatePem);
    const result = verifyToken(token, MACHINE, publicPem);
    assertTrue(result.ok);
    if (result.ok) assertMatch(result.payload.machine, /^[0-9a-f]{64}$/);
  });
});
