import http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEqual, assertTrue, suite } from "./harness";
import {
  compareVersions,
  checkForUpdate,
  resetAppUpdateCache,
  appPolicyCacheFile,
} from "../lib/app-update";

/**
 * 版本更新检查（`/v1/app/policy`）。
 *
 * 用 node:http 起本地假服务端，设 GAOTAI_LICENSE_SERVER 指向它。
 * 覆盖：compareVersions 的语义化比较、blocked 透传、各类失败返回 null（不拦）、
 * 6 小时内存缓存、force 绕过缓存、磁盘缓存 7 天过期。
 *
 * 磁盘缓存隔离：每个用例都指向一次性临时 GAOTAI_DATA_DIR，绝不让测试
 * 读写真实 data/；`checkForUpdate` 的进程内缓存用 `resetAppUpdateCache()` 清零。
 */

type PolicyData = {
  latest: string;
  minSupported: string;
  mode: "link" | "direct";
  url: string;
  notes: string;
  blocked: boolean;
  current: string;
};

function samplePolicy(overrides: Partial<PolicyData> = {}): PolicyData {
  return {
    latest: "0.3.0",
    minSupported: "0.2.5",
    mode: "link",
    url: "https://pan.quark.cn/s/xxx",
    notes: "这次改了什么",
    blocked: true,
    current: "0.2.0",
    ...overrides,
  };
}

/** 起本地假服务端；每收到请求把 body 拼给 handler 断言。 */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    try {
      handler(req, res);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * 每个用例独立的数据目录 + 环境变量隔离。
 *
 * 关键：`checkForUpdate` 会写 `<dataDir>/cache/app-policy.json`，必须指向临时目录，
 * 且用例结束后复原 GAOTAI_LICENSE_SERVER / GAOTAI_DATA_DIR，避免污染后续测试。
 */
function withIsolation<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(path.join(tmpdir(), "gaotai-appupdate-"));
  const prevServer = process.env.GAOTAI_LICENSE_SERVER;
  const prevData = process.env.GAOTAI_DATA_DIR;
  process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${port}`;
  process.env.GAOTAI_DATA_DIR = sandbox;
  return fn()
    .finally(() => {
      if (prevServer === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
      else process.env.GAOTAI_LICENSE_SERVER = prevServer;
      if (prevData === undefined) delete process.env.GAOTAI_DATA_DIR;
      else process.env.GAOTAI_DATA_DIR = prevData;
      try {
        rmSync(sandbox, { recursive: true, force: true });
      } catch {
        // 清理失败不影响结论
      }
    })
    .finally(() => {
      resetAppUpdateCache();
    });
}

suite("compareVersions - 语义化比较", ({ test }) => {
  test("0.2.0 < 0.10.0", () => {
    assertEqual(compareVersions("0.2.0", "0.10.0"), -1);
    assertEqual(compareVersions("0.10.0", "0.2.0"), 1);
  });

  test("1.0 == 1.0.0", () => {
    assertEqual(compareVersions("1.0", "1.0.0"), 0);
    assertEqual(compareVersions("1.0.0", "1.0"), 0);
  });

  test("0.3.0 > 0.2.5", () => {
    assertEqual(compareVersions("0.3.0", "0.2.5"), 1);
  });

  test("v 前缀与相等版本", () => {
    assertEqual(compareVersions("v0.3.0", "0.3.0"), 0);
  });

  test("非法版本返回 null", () => {
    assertEqual(compareVersions("abc", "1.0.0"), null);
    assertEqual(compareVersions("1.0.0", "not-a-version"), null);
    assertEqual(compareVersions("", "1.0.0"), null);
    assertEqual(compareVersions("1..0", "1.0.0"), null);
  });
});

suite("checkForUpdate - 服务端透传", ({ test }) => {
  test("blocked:true → 原样透传（含 latest/url/notes）", async () => {
    const { server, port } = await startServer((req, res) => {
      // 断言带了 version 与 platform 查询参数。
      assertTrue(String(req.url).includes("version="), "请求应带 version 参数");
      assertTrue(String(req.url).includes("platform=win32"), "请求应带 platform=win32");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: samplePolicy({ blocked: true }) }));
    });
    try {
      await withIsolation(port, async () => {
        const policy = await checkForUpdate();
        assertTrue(policy !== null, "blocked:true 应返回策略");
        assertEqual(policy!.blocked, true);
        assertEqual(policy!.latest, "0.3.0");
        assertEqual(policy!.url, "https://pan.quark.cn/s/xxx");
        assertEqual(policy!.notes, "这次改了什么");
      });
    } finally {
      await closeServer(server);
    }
  });

  test("blocked:false → 返回不拦的策略", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: samplePolicy({ blocked: false }) }));
    });
    try {
      await withIsolation(port, async () => {
        const policy = await checkForUpdate();
        assertTrue(policy !== null, "blocked:false 也是合法策略，应返回");
        assertEqual(policy!.blocked, false);
      });
    } finally {
      await closeServer(server);
    }
  });

  test("磁盘缓存落盘成功且结构正确", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: samplePolicy({ blocked: true }) }));
    });
    try {
      await withIsolation(port, async () => {
        await checkForUpdate();
        const file = appPolicyCacheFile();
        assertTrue(existsSync(file), "策略应落盘到 cache/app-policy.json");
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        assertEqual(typeof parsed.fetchedAt, "number");
        assertEqual(parsed.policy.blocked, true);
        assertEqual(parsed.policy.latest, "0.3.0");
      });
    } finally {
      await closeServer(server);
    }
  });
});

suite("checkForUpdate - 失败一律不拦", ({ test }) => {
  test("服务端 500 → null", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "boom", message: "x" } }));
    });
    try {
      await withIsolation(port, async () => {
        assertEqual(await checkForUpdate(), null);
      });
    } finally {
      await closeServer(server);
    }
  });

  test("非 JSON → null", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("this is not json");
    });
    try {
      await withIsolation(port, async () => {
        assertEqual(await checkForUpdate(), null);
      });
    } finally {
      await closeServer(server);
    }
  });

  test("信封 ok:false → null", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "bad", message: "x" } }));
    });
    try {
      await withIsolation(port, async () => {
        assertEqual(await checkForUpdate(), null);
      });
    } finally {
      await closeServer(server);
    }
  });

  test("连不上（端口已关）→ null", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    await closeServer(server);
    await withIsolation(port, async () => {
      assertEqual(await checkForUpdate(), null);
    });
  });
});

suite("checkForUpdate - 缓存", ({ test }) => {
  test("6 小时内第二次调用不再发请求（计数桩）", async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: samplePolicy({ blocked: true }) }));
    });
    try {
      await withIsolation(port, async () => {
        const first = await checkForUpdate();
        assertEqual(first!.blocked, true);
        assertEqual(hits, 1);
        // 第二次：内存缓存命中，不再发网络请求。
        const second = await checkForUpdate();
        assertEqual(second!.blocked, true);
        assertEqual(hits, 1, "第二次调用不应再发请求");
      });
    } finally {
      await closeServer(server);
    }
  });

  test("force:true 绕过缓存，重新发请求", async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: samplePolicy({ blocked: true, latest: `0.3.${hits}` }) }));
    });
    try {
      await withIsolation(port, async () => {
        const first = await checkForUpdate();
        assertEqual(first!.latest, "0.3.1");
        // force 跳过缓存，应命中第二次返回。
        const forced = await checkForUpdate({ force: true });
        assertEqual(forced!.latest, "0.3.2");
        assertEqual(hits, 2, "force 应触发第二次真实请求");
      });
    } finally {
      await closeServer(server);
    }
  });

  test("force 且网络被限流（allowNetwork:false）→ 回退到已缓存的策略", async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: samplePolicy({ blocked: true, latest: "0.3.1" }) }));
    });
    try {
      await withIsolation(port, async () => {
        const first = await checkForUpdate();
        assertEqual(first!.latest, "0.3.1");
        // 模拟限流：网络被禁止，但 force 应回退到内存缓存而不是 null。
        const limited = await checkForUpdate({ force: true, allowNetwork: false });
        assertEqual(limited!.latest, "0.3.1");
        assertEqual(hits, 1, "限流时不应再发请求");
      });
    } finally {
      await closeServer(server);
    }
  });

  test("磁盘缓存跨启动生效：清内存后仍不重发请求", async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: samplePolicy({ blocked: true, latest: "0.3.0" }) }));
    });
    try {
      await withIsolation(port, async () => {
        await checkForUpdate();
        assertEqual(hits, 1);
        // 模拟进程重启：清内存缓存，磁盘缓存应接管。
        resetAppUpdateCache();
        const reloaded = await checkForUpdate();
        assertEqual(reloaded!.latest, "0.3.0");
        assertEqual(hits, 1, "磁盘缓存命中，不应重发请求");
      });
    } finally {
      await closeServer(server);
    }
  });
});

suite("checkForUpdate - 磁盘缓存过期", ({ test }) => {
  test("盘上缓存超过 7 天视为无效，重新走网络", async () => {
    // 先让服务端回一次并落盘。
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: samplePolicy({ blocked: true, latest: "0.3.0" }) }));
    });
    try {
      const sandbox = mkdtempSync(path.join(tmpdir(), "gaotai-appupdate-"));
      const prevServer = process.env.GAOTAI_LICENSE_SERVER;
      const prevData = process.env.GAOTAI_DATA_DIR;
      process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${port}`;
      process.env.GAOTAI_DATA_DIR = sandbox;
      try {
        resetAppUpdateCache();
        const first = await checkForUpdate();
        assertEqual(first!.latest, "0.3.0");
        assertEqual(hits, 1);

        // 把盘上缓存的 fetchedAt 改到 8 天前，模拟过期。
        const file = appPolicyCacheFile();
        const cached = JSON.parse(readFileSync(file, "utf8"));
        cached.fetchedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
        writeFileSync(file, JSON.stringify(cached), "utf8");

        // 清内存缓存后重查：盘上缓存已过期，应重新走网络。
        resetAppUpdateCache();
        const second = await checkForUpdate();
        assertEqual(second!.latest, "0.3.0");
        assertEqual(hits, 2, "过期磁盘缓存不应命中，应重新发请求");
      } finally {
        if (prevServer === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
        else process.env.GAOTAI_LICENSE_SERVER = prevServer;
        if (prevData === undefined) delete process.env.GAOTAI_DATA_DIR;
        else process.env.GAOTAI_DATA_DIR = prevData;
        try {
          rmSync(sandbox, { recursive: true, force: true });
        } catch {
          // ignore
        }
        resetAppUpdateCache();
      }
    } finally {
      await closeServer(server);
    }
  });
});
