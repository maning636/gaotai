import http from "node:http";
import { assertEqual, assertTrue, suite } from "./harness";
import { activate, refresh, status } from "../lib/license/client";

/**
 * 授权客户端通信（协议 §1 / §4）。
 *
 * 用 node:http 起本地假服务端（listen(0) 拿随机端口），
 * 设 GAOTAI_LICENSE_SERVER 指向它。覆盖正常信封、错误信封、
 * 非 JSON、端口关闭、未配置服务器等场景。
 *
 * 每个用例结束 server.close()，绝不挂住进程。
 */

const CODE = "GT-TEST-CODE-1234";
const MACHINE = "a".repeat(64);

/** 用例结束统一清理环境变量。 */
function withServerEnv<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.GAOTAI_LICENSE_SERVER;
  process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${port}`;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
    else process.env.GAOTAI_LICENSE_SERVER = prev;
  });
}

/** 起一个本地假服务端，handler 收到请求后可断言并回响应。 */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        handler(req, res, body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "bad_response", message: String(e) } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

/** 关闭服务端并等待完全关闭。 */
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

suite("授权客户端 - activate", ({ test }) => {
  test("正常信封 → activate 成功", async () => {
    const { server, port } = await startServer((_req, res, body) => {
      const parsed = JSON.parse(body);
      // 断言请求体字段齐全
      assertEqual(typeof parsed.code, "string");
      assertEqual(parsed.code, CODE);
      assertEqual(typeof parsed.machine, "string");
      assertEqual(parsed.machine, MACHINE);
      assertEqual(typeof parsed.appVersion, "string");
      assertEqual(typeof parsed.os, "string");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            token: "gt1.dummy.token",
            expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
            features: ["core", "skills"],
            plan: "free",
            code: CODE,
          },
        }),
      );
    });
    try {
      await withServerEnv(port, async () => {
        const result = await activate({ code: CODE, machine: MACHINE });
        assertTrue(result.ok, "正常信封应激活成功");
        if (result.ok) {
          assertEqual(result.data.token, "gt1.dummy.token");
          assertEqual(result.data.code, CODE);
          assertEqual(result.data.plan, "free");
          assertEqual(result.data.features, ["core", "skills"]);
        }
      });
    } finally {
      await closeServer(server);
    }
  });

  test("错误信封 device_limit + 403 → 透传错误码与中文 message", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "device_limit", message: "设备数已达上限，请先解绑。" },
        }),
      );
    });
    try {
      await withServerEnv(port, async () => {
        const result = await activate({ code: CODE, machine: MACHINE });
        assertEqual(result.ok, false);
        if (!result.ok) {
          assertEqual(result.error.code, "device_limit");
          assertEqual(result.error.message, "设备数已达上限，请先解绑。");
        }
      });
    } finally {
      await closeServer(server);
    }
  });

  test("返回非 JSON（纯文本）→ bad_response", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("this is not json at all");
    });
    try {
      await withServerEnv(port, async () => {
        const result = await activate({ code: CODE, machine: MACHINE });
        assertEqual(result.ok, false);
        if (!result.ok) assertEqual(result.error.code, "bad_response");
      });
    } finally {
      await closeServer(server);
    }
  });

  test("请求带 X-Gaotai-App 头", async () => {
    const { server, port } = await startServer((req, res, body) => {
      // 断言带 X-Gaotai-App 头
      const appHeader = req.headers["x-gaotai-app"];
      assertEqual(typeof appHeader, "string");
      assertTrue((appHeader as string).length > 0, "X-Gaotai-App 头应非空");
      const parsed = JSON.parse(body);
      assertEqual(parsed.code, CODE);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            token: "t",
            expiresAt: Date.now() + 100000,
            features: [],
            plan: "free",
            code: CODE,
          },
        }),
      );
    });
    try {
      await withServerEnv(port, async () => {
        const result = await activate({ code: CODE, machine: MACHINE });
        assertTrue(result.ok);
      });
    } finally {
      await closeServer(server);
    }
  });
});

suite("授权客户端 - refresh", ({ test }) => {
  test("正常信封 → refresh 成功", async () => {
    const { server, port } = await startServer((_req, res, body) => {
      const parsed = JSON.parse(body);
      assertEqual(parsed.code, CODE);
      assertEqual(parsed.machine, MACHINE);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            token: "gt1.refreshed",
            expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
            features: ["core"],
            plan: "pro",
            code: CODE,
          },
        }),
      );
    });
    try {
      await withServerEnv(port, async () => {
        const result = await refresh({ code: CODE, machine: MACHINE });
        assertTrue(result.ok);
        if (result.ok) {
          assertEqual(result.data.token, "gt1.refreshed");
          assertEqual(result.data.plan, "pro");
        }
      });
    } finally {
      await closeServer(server);
    }
  });

  test("code_revoked → 透传", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "code_revoked", message: "注册码已被吊销。" },
        }),
      );
    });
    try {
      await withServerEnv(port, async () => {
        const result = await refresh({ code: CODE, machine: MACHINE });
        assertEqual(result.ok, false);
        if (!result.ok) {
          assertEqual(result.error.code, "code_revoked");
          assertEqual(result.error.message, "注册码已被吊销。");
        }
      });
    } finally {
      await closeServer(server);
    }
  });
});

suite("授权客户端 - status", ({ test }) => {
  test("正常信封 → status 成功", async () => {
    const { server, port } = await startServer((_req, res, body) => {
      const parsed = JSON.parse(body);
      assertEqual(parsed.code, CODE);
      assertEqual(parsed.machine, MACHINE);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            activated: true,
            revoked: false,
            expiresAt: Date.now() + 1000000,
            lastSeenAt: Date.now(),
            plan: "free",
          },
        }),
      );
    });
    try {
      await withServerEnv(port, async () => {
        const result = await status({ code: CODE, machine: MACHINE });
        assertTrue(result.ok);
        if (result.ok) {
          assertEqual(result.data.activated, true);
          assertEqual(result.data.revoked, false);
          assertEqual(result.data.plan, "free");
        }
      });
    } finally {
      await closeServer(server);
    }
  });
});

suite("授权客户端 - 网络异常", ({ test }) => {
  test("打已关闭端口 → server_unreachable", async () => {
    // 起一个服务端拿到端口，然后立刻关掉，确保端口没人监听
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    await closeServer(server);
    await withServerEnv(port, async () => {
      const result = await activate({ code: CODE, machine: MACHINE });
      assertEqual(result.ok, false);
      if (!result.ok) assertEqual(result.error.code, "server_unreachable");
    });
  });
});

suite("授权客户端 - 未配置服务器", ({ test }) => {
  test("activate 未配 GAOTAI_LICENSE_SERVER → server_not_configured", async () => {
    const prev = process.env.GAOTAI_LICENSE_SERVER;
    delete process.env.GAOTAI_LICENSE_SERVER;
    try {
      const result = await activate({ code: CODE, machine: MACHINE });
      assertEqual(result.ok, false);
      if (!result.ok) assertEqual(result.error.code, "server_not_configured");
    } finally {
      if (prev !== undefined) process.env.GAOTAI_LICENSE_SERVER = prev;
    }
  });

  test("refresh 未配 GAOTAI_LICENSE_SERVER → server_not_configured", async () => {
    const prev = process.env.GAOTAI_LICENSE_SERVER;
    delete process.env.GAOTAI_LICENSE_SERVER;
    try {
      const result = await refresh({ code: CODE, machine: MACHINE });
      assertEqual(result.ok, false);
      if (!result.ok) assertEqual(result.error.code, "server_not_configured");
    } finally {
      if (prev !== undefined) process.env.GAOTAI_LICENSE_SERVER = prev;
    }
  });

  test("status 未配 GAOTAI_LICENSE_SERVER → server_not_configured", async () => {
    const prev = process.env.GAOTAI_LICENSE_SERVER;
    delete process.env.GAOTAI_LICENSE_SERVER;
    try {
      const result = await status({ code: CODE, machine: MACHINE });
      assertEqual(result.ok, false);
      if (!result.ok) assertEqual(result.error.code, "server_not_configured");
    } finally {
      if (prev !== undefined) process.env.GAOTAI_LICENSE_SERVER = prev;
    }
  });
});
