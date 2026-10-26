import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import { checkWechatConnection, explainWechatError, extractEgressIp } from "../lib/wechat-check";
import { clearAccessTokenCache } from "../lib/wechat";

/**
 * 公众号通道检查的测试。
 *
 * 这一层的价值全在两件事上：
 * 1. 微信的错误码能不能翻成人话；
 * 2. 40164 的报错里能不能把「微信看到的本机 IP」抠出来——
 *    抠出来用户就能直接抄，不用自己去别处查公网 IP。
 *
 * 错误码映射是纯函数，不发任何请求就能验；
 * 连接检查则用 fetch 桩，不打真实网络。
 */

const CREDENTIALS = { appId: "wx-stub-app", appSecret: "stub-secret" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

suite("公众号通道检查：错误码翻译", ({ test }) => {
  test("40164 说清是 IP 白名单，并把微信看到的 IP 抠出来", () => {
    const explained = explainWechatError(
      40164,
      "invalid ip 61.144.242.162, not in whitelist",
    );
    assertMatch(explained.reason, /IP 白名单/);
    assertMatch(explained.hint, /IP白名单/);
    assertEqual(explained.egressIp, "61.144.242.162");
  });

  test("40164 不带逗号的那种写法也能抠出 IP", () => {
    const explained = explainWechatError(40164, "invalid ip 1.2.3.4 not in whitelist");
    assertEqual(explained.egressIp, "1.2.3.4");
  });

  test("报错里没有 IP 时不硬编一个出来", () => {
    const explained = explainWechatError(40164, "invalid ip not in whitelist");
    assertEqual(explained.egressIp, undefined);
    assertMatch(explained.reason, /IP 白名单/);
  });

  test("40125 说的是 AppSecret 不对", () => {
    const explained = explainWechatError(40125, "invalid appsecret");
    assertMatch(explained.reason, /AppSecret/);
  });

  test("40013 说的是 AppID 不对", () => {
    const explained = explainWechatError(40013, "invalid appid");
    assertMatch(explained.reason, /AppID/);
  });

  test("48001 说的是账号没这个接口的权限，并给出改用复制排版的出路", () => {
    const explained = explainWechatError(48001, "api unauthorized");
    assertMatch(explained.reason, /权限/);
    assertMatch(explained.hint, /复制排版正文/);
  });

  test("不认识的错误码走兜底：把微信原话带出去，别装作认识", () => {
    const explained = explainWechatError(99999, "some brand new error");
    assertMatch(explained.reason, /99999/);
    assertMatch(explained.reason, /some brand new error/);
  });

  test("只抠 IP，不把别的东西当 IP", () => {
    assertEqual(extractEgressIp("invalid ip abc.def.ghi not in whitelist"), undefined);
    assertEqual(extractEgressIp(undefined), undefined);
    assertEqual(extractEgressIp("invalid ip 999.1.1.1 not in whitelist"), "999.1.1.1");
  });
});

suite("公众号通道检查：连接判定", ({ test }) => {
  const originalFetch = globalThis.fetch;

  test("拿到 access_token 就算通", async () => {
    globalThis.fetch = (async () => jsonResponse({ access_token: "T", expires_in: 7200 })) as typeof globalThis.fetch;
    clearAccessTokenCache();
    try {
      const result = await checkWechatConnection(CREDENTIALS);
      assertEqual(result.ok, true);
      assertMatch(result.reason, /已打通/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("40164 时不通，并且把出口 IP 带出来", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ errcode: 40164, errmsg: "invalid ip 61.144.242.162, not in whitelist" })) as typeof globalThis.fetch;
    clearAccessTokenCache();
    try {
      const result = await checkWechatConnection(CREDENTIALS);
      assertEqual(result.ok, false);
      assertEqual(result.errcode, 40164);
      assertEqual(result.egressIp, "61.144.242.162");
      assertMatch(result.hint, /IP白名单/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("连不上服务器时也给得出下一步，而不是只抛异常", async () => {
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.weixin.qq.com");
    }) as typeof globalThis.fetch;
    clearAccessTokenCache();
    try {
      const result = await checkWechatConnection(CREDENTIALS);
      assertEqual(result.ok, false);
      assertMatch(result.reason, /连不上/);
      assertMatch(result.hint, /api\.weixin\.qq\.com/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("没填凭据时提示去填，不去打微信", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as typeof globalThis.fetch;
    clearAccessTokenCache();
    try {
      const result = await checkWechatConnection({ appId: "", appSecret: "" });
      assertEqual(result.ok, false);
      assertTrue(!called, "没凭据就不该发请求");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
