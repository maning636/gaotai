import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import { imagesDir } from "../lib/paths";
import { clearAccessTokenCache, createDraft, uploadInlineImage, uploadPermanentImage } from "../lib/wechat";
import { cdnizeLocalImages } from "../lib/wechat-images";

/**
 * 微信接口的离线测试。
 *
 * 这里把全局 fetch 换成桩函数，不发真实请求：验证的是**请求打到了哪个接口、
 * 参数长什么样、返回的地址有没有被用上**，这些是最容易悄悄写错的地方。
 * 真发请求需要公众号凭据和 IP 白名单，本机不具备，所以只测到接口边界。
 */

type Call = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 装一个假微信服务器：按接口名回不同的东西。 */
function stubWechat(calls: Call[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/cgi-bin/token")) {
      return jsonResponse({ access_token: "TEST-TOKEN", expires_in: 7200 });
    }
    if (url.includes("/cgi-bin/media/uploadimg")) {
      return jsonResponse({ url: "https://mmbiz.qpic.cn/mmbiz_jpg/inline/640?wx_fmt=jpeg" });
    }
    if (url.includes("/cgi-bin/material/add_material")) {
      return jsonResponse({ media_id: "COVER-MEDIA-ID", url: "https://mmbiz.qpic.cn/mmbiz_jpg/cover/640" });
    }
    if (url.includes("/cgi-bin/draft/add")) {
      return jsonResponse({ media_id: "DRAFT-MEDIA-ID" });
    }
    return jsonResponse({ errcode: 40001, errmsg: "unsupported in stub" });
  }) as typeof globalThis.fetch;
}

const CREDENTIALS = { appId: "wx-stub-app", appSecret: "stub-secret" };

suite("微信公众号接口", ({ test }) => {
  const originalFetch = globalThis.fetch;

  test("正文插图走图文消息图片接口，不占素材库配额", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    try {
      const dir = imagesDir();
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "inline.png");
      writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const asset = await uploadInlineImage(file, CREDENTIALS);
      assertMatch(asset.url, /^https:\/\/mmbiz\.qpic\.cn\//);

      const upload = calls.find(call => call.url.includes("/cgi-bin/media/uploadimg"));
      assertTrue(upload !== undefined, "正文图片应该走 media/uploadimg");
      assertTrue(upload!.init?.body instanceof FormData, "上传体应该是 multipart 表单");
      assertTrue(
        !calls.some(call => call.url.includes("material/add_material")),
        "正文图片不该走永久素材接口",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("封面走永久素材接口，拿回 media_id", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    try {
      const dir = imagesDir();
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "cover.png");
      writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const asset = await uploadPermanentImage(file, CREDENTIALS);
      assertEqual(asset.mediaId, "COVER-MEDIA-ID");
      const upload = calls.find(call => call.url.includes("material/add_material"));
      assertTrue(upload !== undefined, "封面应该走 material/add_material");
      assertTrue(upload!.url.includes("type=image"), "永久素材的类型参数应该是 image");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("推草稿时带上封面 media_id 和排版好的正文", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    try {
      await createDraft({
        title: "一篇稿子",
        content: "<section>正文</section>",
        digest: "摘要",
        thumbMediaId: "COVER-MEDIA-ID",
        creds: CREDENTIALS,
      });

      const draft = calls.find(call => call.url.includes("/cgi-bin/draft/add"));
      assertTrue(draft !== undefined, "应该调用草稿接口");
      const body = JSON.parse(String(draft!.init?.body)) as {
        articles: { title: string; content: string; thumb_media_id: string }[];
      };
      assertEqual(body.articles[0].thumb_media_id, "COVER-MEDIA-ID");
      assertEqual(body.articles[0].title, "一篇稿子");
      assertMatch(body.articles[0].content, /<section>/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("没有封面时拒绝推草稿，而且一个请求都不该发出去", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    try {
      await createDraft({ title: "无封面", content: "<p>x</p>", creds: CREDENTIALS }).then(
        () => {
          throw new Error("没有封面时不应该推送成功");
        },
        (error: unknown) => {
          assertTrue(error instanceof Error, "应该抛错");
          assertMatch((error as Error).message, /封面/);
        },
      );
      assertEqual(calls.length, 0, "缺封面时不该先去调微信接口");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("正文里的本机图片被换成微信地址", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    try {
      const dir = imagesDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "body.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const report = await cdnizeLocalImages("![图](/api/files/img/body.png)\n\n正文", CREDENTIALS);
      assertEqual(report.uploaded, 1);
      assertEqual(report.failed.length, 0);
      assertTrue(!report.markdown.includes("/api/files/img/"), "换完不该还剩本机地址");
      assertMatch(report.markdown, /https:\/\/mmbiz\.qpic\.cn\//);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("某张图上传失败不影响其它图，失败项被如实报回", async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/cgi-bin/token")) return jsonResponse({ access_token: "T", expires_in: 7200 });
      if (url.includes("/cgi-bin/media/uploadimg")) return jsonResponse({ errcode: 45009, errmsg: "rate limit" });
      return jsonResponse({ errcode: 40001, errmsg: "unsupported" });
    }) as typeof globalThis.fetch;
    clearAccessTokenCache();
    try {
      const dir = imagesDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "bad.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const report = await cdnizeLocalImages("![图](/api/files/img/bad.png)", CREDENTIALS);
      assertEqual(report.uploaded, 0);
      assertEqual(report.failed.length, 1);
      assertMatch(report.failed[0].reason, /45009|rate limit/);
      assertTrue(report.markdown.includes("/api/files/img/bad.png"), "失败的图地址保持原样，不编造地址");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("素材库里不存在的图不会去上传，直接算失败", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    try {
      const report = await cdnizeLocalImages("![图](/api/files/img/not-there.png)", CREDENTIALS);
      assertEqual(report.uploaded, 0);
      assertEqual(report.failed.length, 1);
      assertTrue(!calls.some(call => call.url.includes("uploadimg")), "找不到文件就不该发上传请求");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
