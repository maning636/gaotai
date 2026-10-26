import { assertEqual, assertTrue, suite } from "./harness";
import {
  hashPassword,
  signSession,
  verifyBootToken,
  verifyPassword,
  verifySession,
} from "../lib/auth";

suite("认证与口令", ({ test }) => {
  test("口令哈希后能通过校验", () => {
    const stored = hashPassword("correct horse");
    assertTrue(verifyPassword("correct horse", stored));
    assertEqual(verifyPassword("wrong horse", stored), false);
  });

  test("同一口令两次哈希结果不同（盐生效）", () => {
    const a = hashPassword("same");
    const b = hashPassword("same");
    assertTrue(a !== b, "两次哈希应当因为随机盐而不同");
    assertTrue(verifyPassword("same", a));
    assertTrue(verifyPassword("same", b));
  });

  test("残缺或畸形的存储值不会误判为通过", () => {
    assertEqual(verifyPassword("x", ""), false);
    assertEqual(verifyPassword("x", "no-colon"), false);
    assertEqual(verifyPassword("x", "salt:"), false);
    assertEqual(verifyPassword("x", ":deadbeef"), false);
  });

  test("会话令牌可验签且带过期时间", () => {
    const now = Date.now();
    const token = signSession({ sub: "owner", iat: now, exp: now + 60_000 });
    const payload = verifySession(token);
    assertTrue(payload !== null);
    assertEqual(payload!.sub, "owner");
    assertTrue(payload!.exp > now);
  });

  test("过期会话与被篡改的令牌都会被拒绝", () => {
    const now = Date.now();
    const expired = signSession({ sub: "owner", iat: now - 10_000, exp: now - 1_000 });
    assertEqual(verifySession(expired), null);

    const valid = signSession({ sub: "owner", iat: now, exp: now + 60_000 });
    assertEqual(verifySession(`${valid}x`), null);
    assertEqual(verifySession("garbage"), null);
    assertEqual(verifySession(undefined), null);
  });

  test("签名不匹配的令牌无法伪造", () => {
    const now = Date.now();
    const forged = signSession({ sub: "intruder", iat: now, exp: now + 60_000 });
    const [body] = forged.split(".");
    // 只保留合法 body，签名换成别的合法签名
    const other = signSession({ sub: "other", iat: now, exp: now + 60_000 });
    const [, otherSig] = other.split(".");
    assertEqual(verifySession(`${body}.${otherSig}`), null);
  });
});

/**
 * 启动令牌。
 *
 * 桌面客户端每次启动随机生成一个，通过环境变量交给后端，
 * 窗口打开前用它换一个会话——用户全程不面对任何输入框。
 * 令牌只对当次进程有效，所以它必须**只认当前那一份**。
 */
suite("启动令牌", ({ test }) => {
  test("认当前进程的那一份", () => {
    process.env.GAOTAI_BOOT_TOKEN = "boot-token-for-test";
    assertTrue(verifyBootToken("boot-token-for-test"));
  });

  test("别的令牌一律不认", () => {
    process.env.GAOTAI_BOOT_TOKEN = "boot-token-for-test";
    assertEqual(verifyBootToken("wrong-token"), false);
    assertEqual(verifyBootToken(""), false);
    assertEqual(verifyBootToken("boot-token-for-test-longer"), false);
  });

  test("后端没有令牌时，谁来换会话都不行", () => {
    delete process.env.GAOTAI_BOOT_TOKEN;
    assertEqual(verifyBootToken("anything"), false);
    assertEqual(verifyBootToken(""), false);
  });
});
