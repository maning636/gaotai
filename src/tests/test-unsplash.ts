import { assertEqual, assertTrue, suite } from "./harness";
import {
  searchPhotos,
  trackDownload,
  unsplashKeyError,
} from "../lib/ai-image/unsplash";

/**
 * Unsplash 模块测试。
 *
 * 只测逻辑：未配置 key 时抛明确错误、trackDownload 的请求格式。
 * 不实际调 Unsplash API（环境里也没有 key）。
 */

suite("Unsplash：未配置 key", ({ test }) => {
  const originalKey = process.env.UNSPLASH_ACCESS_KEY;

  test("searchPhotos 在未配置 key 时抛明确错误", async () => {
    delete process.env.UNSPLASH_ACCESS_KEY;
    let threw = false;
    try {
      await searchPhotos("city");
    } catch (error) {
      threw = true;
      assertTrue(error instanceof Error, "应抛 Error");
      assertTrue((error as Error).message.includes("UNSPLASH_ACCESS_KEY"), "错误信息要点名环境变量");
    }
    assertTrue(threw, "未配置 key 该抛错");
  });

  test("unsplashKeyError 返回带可读信息的 Error", () => {
    const error = unsplashKeyError();
    assertTrue(error.message.includes("UNSPLASH_ACCESS_KEY"), "提示里要点名配置项");
  });

  // 恢复环境变量，避免污染其他用例。
  test("恢复原 key", () => {
    if (originalKey === undefined) delete process.env.UNSPLASH_ACCESS_KEY;
    else process.env.UNSPLASH_ACCESS_KEY = originalKey;
  });
});

suite("Unsplash：请求格式", ({ test }) => {
  const originalKey = process.env.UNSPLASH_ACCESS_KEY;
  const originalFetch = globalThis.fetch;

  test("trackDownload 用 POST + Client-ID 头请求 download_location", async () => {
    process.env.UNSPLASH_ACCESS_KEY = "test-key";
    let called: { url: string; method: string; header: string | null } | null = null;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      called = {
        url: String(url),
        method: String(init?.method ?? "GET"),
        header: new Headers(init?.headers).get("Authorization"),
      };
      return new Response("", { status: 204 });
    }) as typeof fetch;
    try {
      await trackDownload("https://api.unsplash.com/photos/photo-1/download");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertTrue(called !== null, "fetch 应被调用");
    assertEqual(called!.url, "https://api.unsplash.com/photos/photo-1/download");
    assertEqual(called!.method, "POST", "上报必须是 POST");
    assertEqual(called!.header, "Client-ID test-key", "头必须是 Client-ID <key>");
  });

  test("trackDownload 上报失败不抛错（fire-and-forget）", async () => {
    process.env.UNSPLASH_ACCESS_KEY = "test-key";
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      await trackDownload("https://api.unsplash.com/photos/x/download");
    } finally {
      globalThis.fetch = originalFetch;
    }
    // 走到这里说明没抛，即 fire-and-forget 生效。
    assertTrue(true);
  });

  test("恢复环境变量与 fetch", () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.UNSPLASH_ACCESS_KEY;
    else process.env.UNSPLASH_ACCESS_KEY = originalKey;
  });
});
