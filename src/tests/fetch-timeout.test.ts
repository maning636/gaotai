import http from "node:http";
import { assertEqual, assertTrue, suite } from "./harness";
import { ensureLongLivedFetchTimeout } from "../lib/fetch-timeout";

/**
 * Node 的 fetch 走内置 undici，默认只等 300 秒的响应头。
 * 写长文时模型要先算完再一次性回正文，响应头会晚到——
 * 头等不到，请求就被掐断，用户等了半天换来一句「模型请求失败」。
 *
 * 上游 we-article 正是撞在这上面：SDK 超时设了 600 秒，
 * undici 的 300 秒头部超时先到，报 fetch timed out waiting for response headers。
 */
const DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");

type DispatcherCtor = new (options: Record<string, number>) => unknown;

function scopeWithDispatcher(): typeof globalThis & { [key: symbol]: unknown } {
  return globalThis as typeof globalThis & { [key: symbol]: unknown };
}

suite("fetch 的响应头超时", ({ test }) => {
  test("能换掉全局 dispatcher", () => {
    const scope = scopeWithDispatcher();
    const before = scope[DISPATCHER_SYMBOL];
    const changed = ensureLongLivedFetchTimeout();
    assertTrue(changed, "应该能把全局 dispatcher 换掉");
    assertTrue(Boolean(scope[DISPATCHER_SYMBOL]), "换完之后 dispatcher 还得在");
    assertTrue(scope[DISPATCHER_SYMBOL] !== before, "换掉的应该是原来那一个");
  });

  test("换成宽松的超时后，慢响应的请求能等到；原来那种等不到", async () => {
    const scope = scopeWithDispatcher();
    const original = scope[DISPATCHER_SYMBOL];
    const Ctor = (original as { constructor?: DispatcherCtor })?.constructor;
    assertTrue(Boolean(Ctor), "拿不到 dispatcher 的构造函数");

    // 一个 2 秒之后才回响应头的本地服务。
    // 注意：undici 的头部超时有约 1 秒的下限，所以这里的超时值不能取太小，
    // 否则压根不会触发，测出来的「成功」是假的。
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, 2000);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      // 先装一个头部超时只有 1 秒的 dispatcher：这个请求必然等不到
      scope[DISPATCHER_SYMBOL] = new Ctor!({
        headersTimeout: 1000,
        bodyTimeout: 1000,
        connectTimeout: 10_000,
      });
      let timedOut = false;
      try {
        await fetch(`http://127.0.0.1:${port}/`);
      } catch {
        timedOut = true;
      }
      assertTrue(timedOut, "头部超时 1 秒时，2 秒才回头的请求应当失败");

      // 换成我们自己的配置后，同一个请求就能等到
      assertTrue(ensureLongLivedFetchTimeout(), "应该能替换全局 dispatcher");
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assertEqual(response.status, 200);
    } finally {
      scope[DISPATCHER_SYMBOL] = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("重复调用不会报错", () => {
    ensureLongLivedFetchTimeout();
    ensureLongLivedFetchTimeout();
    assertTrue(true, "重复调用应当是安全的");
  });
});
