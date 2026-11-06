import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertEqual, assertTrue, suite } from "./harness";
import { imageFingerprint, fingerprintFile, getCachedUrl, setCachedUrl, clearImageCache } from "../lib/wechat/image-cache";
import { cdnizeLocalImages } from "../lib/wechat-images";
import { clearAccessTokenCache } from "../lib/wechat";
import { imagesDir } from "../lib/paths";

/**
 * 图片指纹缓存测试。
 *
 * 指纹是图片**内容**的 sha256，用来判断「这张图要不要重新上传微信」。
 * 这里验证：同一内容指纹一致、缓存命中能拿到地址、熔断时不再发请求。
 */

type Call = { url: string };

const CREDENTIALS = { appId: "wx-stub-app", appSecret: "stub-secret" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 装一个假微信服务器，记下所有调用，可配置是否撞 45009。 */
function stubWechat(calls: Call[], options: { rateLimit?: boolean } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    if (url.includes("/cgi-bin/token")) return jsonResponse({ access_token: "TEST-TOKEN", expires_in: 7200 });
    if (url.includes("/cgi-bin/media/uploadimg")) {
      if (options.rateLimit) return jsonResponse({ errcode: 45009, errmsg: "api freq out of limit" });
      return jsonResponse({ url: `https://mmbiz.qpic.cn/mmbiz_jpg/inline/${calls.length}?wx_fmt=jpeg` });
    }
    return jsonResponse({ errcode: 40001, errmsg: "unsupported in stub" });
  }) as typeof globalThis.fetch;
}

/** 在素材库写一张图，返回相对路径与磁盘路径。 */
function seedImage(name: string, bytes: Buffer): { url: string; abs: string } {
  const dir = imagesDir();
  mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  writeFileSync(abs, bytes);
  return { url: `/api/files/img/${encodeURIComponent(name)}`, abs };
}

suite("图片指纹缓存", ({ test }) => {
  const originalFetch = globalThis.fetch;

  test("相同内容算出一致的指纹，不同内容指纹不同", () => {
    const a = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const b = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]);
    assertEqual(imageFingerprint(a), imageFingerprint(a));
    assertTrue(imageFingerprint(a) !== imageFingerprint(b), "不同内容不该同指纹");
    assertTrue(imageFingerprint(a).length === 64, "指纹应该是 64 位十六进制");
  });

  test("写入后能按指纹取回地址；未写入返回 null", () => {
    const fp = imageFingerprint(Buffer.from([1, 2, 3]));
    assertEqual(getCachedUrl(fp), null);
    setCachedUrl(fp, "https://mmbiz.qpic.cn/cached/1");
    assertEqual(getCachedUrl(fp), "https://mmbiz.qpic.cn/cached/1");
  });

  test("空指纹不查也不写", () => {
    setCachedUrl("", "https://x");
    assertEqual(getCachedUrl(""), null);
  });

  test("指纹文件读得到返回指纹，读不到返回 null", async () => {
    const { abs } = seedImage("fp.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
    const fp = await fingerprintFile(abs);
    assertTrue(fp !== null && fp.length === 64, "能读到文件就该有指纹");
    const missing = await fingerprintFile(path.join(imagesDir(), "nope.png"));
    assertEqual(missing, null);
  });

  test("二次推送同一张图命中缓存，不再发上传请求", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    clearImageCache();
    try {
      const { url } = seedImage("dup.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]));
      const first = await cdnizeLocalImages(`![图](${url})`, CREDENTIALS);
      assertEqual(first.uploaded, 1);
      assertEqual(first.cached, 0);

      // 第二次：图片内容没变，命中缓存，一个上传请求都不该发。
      const uploadsBefore = calls.filter(call => call.url.includes("uploadimg")).length;
      const second = await cdnizeLocalImages(`![图](${url})`, CREDENTIALS);
      const uploadsAfter = calls.filter(call => call.url.includes("uploadimg")).length;
      assertEqual(second.uploaded, 0, "命中缓存不该算新上传");
      assertEqual(second.cached, 1, "应该算一次缓存命中");
      assertEqual(second.failed.length, 0);
      assertEqual(second.markdown, first.markdown, "地址应该与首次一致");
      assertEqual(uploadsAfter, uploadsBefore, "命中缓存时不该再发上传请求");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("图片内容变了就走上传，不命中旧缓存", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    clearImageCache();
    try {
      const { url, abs } = seedImage("change.png", Buffer.from([1, 1, 1]));
      await cdnizeLocalImages(`![图](${url})`, CREDENTIALS);
      writeFileSync(abs, Buffer.from([2, 2, 2]));
      const again = await cdnizeLocalImages(`![图](${url})`, CREDENTIALS);
      assertEqual(again.uploaded, 1, "内容变了应该重新上传");
      assertEqual(again.cached, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("撞上 45009 熔断：整篇抛错，后续批次不再发请求", async () => {
    const calls: Call[] = [];
    // 第二张起 45009：第一批（3 张）里有一张撞线，第二批（后 3 张）不该再发。
    let uploadCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });
      if (url.includes("/cgi-bin/token")) return jsonResponse({ access_token: "T", expires_in: 7200 });
      if (url.includes("/cgi-bin/media/uploadimg")) {
        uploadCount += 1;
        if (uploadCount >= 2) return jsonResponse({ errcode: 45009, errmsg: "api freq out of limit" });
        return jsonResponse({ url: `https://mmbiz.qpic.cn/inline/${uploadCount}` });
      }
      return jsonResponse({ errcode: 40001, errmsg: "unsupported" });
    }) as typeof globalThis.fetch;
    clearAccessTokenCache();
    clearImageCache();
    try {
      const dir = imagesDir();
      mkdirSync(dir, { recursive: true });
      const refs = [1, 2, 3, 4, 5, 6].map(i => {
        const name = `b${i}.png`;
        writeFileSync(path.join(dir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47, i]));
        return `/api/files/img/${name}`;
      });
      const markdown = refs.map(ref => `![图](${ref})`).join("\n");
      let threw = false;
      try {
        await cdnizeLocalImages(markdown, CREDENTIALS);
      } catch (error) {
        threw = true;
        assertTrue(error instanceof Error, "应抛错");
        assertTrue((error as Error).message.includes("45009"), "错误信息要带 45009");
      }
      assertTrue(threw, "45009 应该让整篇熔断抛错");
      // 熔断后第二批（后 3 张）不该再发：只允许 token + 第一批的 3 张 uploadimg。
      const uploads = calls.filter(call => call.url.includes("uploadimg"));
      assertEqual(uploads.length, 3, "熔断后不该再发第二批上传");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("非致命失败用黄图占位，不打断其它图", async () => {
    const calls: Call[] = [];
    // 两张图都非致命失败（40007 invalid media）：都不该让整篇抛错，
    // 而是各自换黄图占位，失败项如实报回。
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });
      if (url.includes("/cgi-bin/token")) return jsonResponse({ access_token: "T", expires_in: 7200 });
      if (url.includes("/cgi-bin/media/uploadimg")) return jsonResponse({ errcode: 40007, errmsg: "invalid media" });
      return jsonResponse({ errcode: 40001, errmsg: "unsupported" });
    }) as typeof globalThis.fetch;
    clearAccessTokenCache();
    clearImageCache();
    try {
      const dir = imagesDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "ok.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
      writeFileSync(path.join(dir, "bad.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]));
      const markdown = "![a](/api/files/img/ok.png)\n![b](/api/files/img/bad.png)";
      const report = await cdnizeLocalImages(markdown, CREDENTIALS);
      assertEqual(report.uploaded, 0, "非致命失败不该算上传成功");
      assertEqual(report.failed.length, 2, "两张失败图都该报回");
      assertEqual(report.markdown.split("data:image/png;base64,").length - 1, 2, "两张都该用黄图占位");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("并发不超过 3 路：一批 3 张同时发", async () => {
    // 用 6 张图验证并发上限：同一时刻在飞的 uploadimg 不超过 3。
    const inFlight: { url: string; done: boolean }[] = [];
    let maxInFlight = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cgi-bin/token")) return jsonResponse({ access_token: "T", expires_in: 7200 });
      if (url.includes("/cgi-bin/media/uploadimg")) {
        const record = { url, done: false };
        inFlight.push(record);
        maxInFlight = Math.max(maxInFlight, inFlight.filter(r => !r.done).length);
        await new Promise(resolve => setTimeout(resolve, 20));
        record.done = true;
        return jsonResponse({ url: `https://mmbiz.qpic.cn/inline/${inFlight.length}` });
      }
      return jsonResponse({ errcode: 40001, errmsg: "unsupported" });
    }) as typeof globalThis.fetch;
    clearAccessTokenCache();
    clearImageCache();
    try {
      const dir = imagesDir();
      mkdirSync(dir, { recursive: true });
      const refs = [1, 2, 3, 4, 5, 6].map(i => {
        const name = `c${i}.png`;
        writeFileSync(path.join(dir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47, i]));
        return `/api/files/img/${name}`;
      });
      const report = await cdnizeLocalImages(refs.map(ref => `![图](${ref})`).join("\n"), CREDENTIALS);
      assertEqual(report.uploaded, 6);
      assertTrue(maxInFlight <= 3, `并发不该超过 3，实际 ${maxInFlight}`);
      assertTrue(maxInFlight >= 2, "应该真的有并发（不然没测到并发逻辑）");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
