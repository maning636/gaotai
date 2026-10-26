import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import { clearAccessTokenCache } from "../lib/wechat";
import { createProject, getWxPreference, saveStageResult, saveWxPreference } from "../lib/repo";
import { pushDraft } from "../app/api/wechat/draft/route";

/**
 * 草稿推送幂等性测试。
 *
 * 手法沿用 wechat-api.test.ts：把全局 fetch 换成桩函数，不发真实请求，
 * 只验证「调了哪个接口、参数长什么样、同一个草稿有没有被推两次」。
 *
 * 直接驱动 pushDraft 而不是打 POST——POST 要先过登录守卫，而守卫靠
 * next/headers 的请求上下文，在单测进程里搭不起来。
 */

type Call = { url: string; init?: RequestInit };

const CREDENTIALS = { appId: "wx-stub-app", appSecret: "stub-secret" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 装一个假微信服务器：草稿新建和更新都回同一个 media_id。 */
function stubWechat(calls: Call[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/cgi-bin/token")) return jsonResponse({ access_token: "TEST-TOKEN", expires_in: 7200 });
    if (url.includes("/cgi-bin/media/uploadimg")) {
      return jsonResponse({ url: "https://mmbiz.qpic.cn/mmbiz_jpg/inline/640?wx_fmt=jpeg" });
    }
    if (url.includes("/cgi-bin/draft/add")) return jsonResponse({ media_id: "DRAFT-MEDIA-ID" });
    if (url.includes("/cgi-bin/draft/update")) return jsonResponse({ media_id: "DRAFT-MEDIA-ID" });
    return jsonResponse({ errcode: 40001, errmsg: "unsupported in stub" });
  }) as typeof globalThis.fetch;
}

function draftCalls(calls: Call[]): Call[] {
  return calls.filter(call => call.url.includes("/cgi-bin/draft/"));
}

/** 造一篇带标题的稿子，标题固定成「稿件标题」方便断言。 */
function fixtureArticle(content = "# 稿件标题\n\n正文第一段内容。"): string {
  const project = createProject({ title: "幂等测试稿", topicId: "general" });
  saveStageResult({ projectId: project.id, stage: "article", content, status: "confirmed" });
  return project.id;
}

suite("草稿推送幂等", ({ test }) => {
  const originalFetch = globalThis.fetch;

  test("首次推送走 draft/add 新建，并把 media_id 和指纹存下来", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    const projectId = fixtureArticle();
    try {
      const result = await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);

      assertEqual(result.ok, true);
      assertEqual(result.action, "created");
      assertEqual(result.mediaId, "DRAFT-MEDIA-ID");
      assertEqual(result.title, "稿件标题");
      assertEqual(result.uploadedImages, 0);
      assertEqual(result.failedImages.length, 0);

      assertEqual(draftCalls(calls).length, 1);
      assertTrue(calls.some(call => call.url.includes("/cgi-bin/draft/add")), "应该走草稿新建接口");
      const body = JSON.parse(String(draftCalls(calls)[0].init?.body)) as { articles: { title: string }[] };
      assertEqual(body.articles[0].title, "稿件标题");

      const pref = getWxPreference(projectId);
      assertTrue(pref !== null, "推送成功后应该有偏好记录");
      assertEqual(pref!.draft_media_id, "DRAFT-MEDIA-ID");
      assertTrue(pref!.draft_fingerprint.length === 64, "指纹应该是 sha256 的十六进制摘要");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("内容不变时不重复推送，直接返回已有的 media_id", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    const projectId = fixtureArticle();
    try {
      const first = await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);
      const second = await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);

      assertEqual(first.action, "created");
      assertEqual(second.action, "unchanged");
      assertEqual(second.mediaId, first.mediaId, "未变化时应回同一份草稿的 media_id");

      // 两次推送总共只调了一次草稿接口——这是防重复的关键
      assertEqual(draftCalls(calls).length, 1);
      assertTrue(!calls.some(call => call.url.includes("/cgi-bin/draft/update")), "未变化不该去更新草稿");
      assertTrue(
        draftCalls(calls).every(call => call.url.includes("/cgi-bin/draft/add")),
        "只应有一次 draft/add",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("内容变化时更新原来那份草稿，而不是再新建一份", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    const projectId = fixtureArticle();
    try {
      const first = await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);
      assertEqual(first.action, "created");

      // 改一处正文，指纹就该变
      saveStageResult({ projectId, stage: "article", content: "# 稿件标题\n\n正文第一段内容，改了一个字。", status: "confirmed" });
      const second = await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);

      assertEqual(second.action, "updated");
      assertEqual(second.mediaId, first.mediaId, "更新后 media_id 不变，还是那一份草稿");

      const update = calls.find(call => call.url.includes("/cgi-bin/draft/update"));
      assertTrue(update !== undefined, "内容变了应该走草稿更新接口");
      const body = JSON.parse(String(update!.init?.body)) as {
        media_id: string;
        index: number;
        articles: { title: string; content: string; thumb_media_id: string }[];
      };
      assertEqual(body.media_id, "DRAFT-MEDIA-ID");
      assertEqual(body.index, 0, "单篇草稿的更新位置固定是 0");
      assertMatch(body.articles[0].content, /改了一个字/);
      assertEqual(body.articles[0].thumb_media_id, "COVER-1");

      // 只调过 draft/add 一次，draft/update 一次——没有多余的新建
      assertEqual(calls.filter(call => call.url.includes("/cgi-bin/draft/add")).length, 1);
      assertEqual(calls.filter(call => call.url.includes("/cgi-bin/draft/update")).length, 1);

      // 更新后指纹已刷新，紧接着再推一次就该是未变化
      const third = await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);
      assertEqual(third.action, "unchanged");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("只改标题也算变化，指纹会跟着变", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    const projectId = fixtureArticle();
    try {
      await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);
      // 正文一模一样，只传了一个不同的标题
      const second = await pushDraft({ projectId, thumbMediaId: "COVER-1", title: "换个标题" }, CREDENTIALS);
      assertEqual(second.action, "updated");
      assertEqual(second.title, "换个标题");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("换主题会让 HTML 变化，因此触发更新", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    const projectId = fixtureArticle();
    try {
      await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);
      const second = await pushDraft({ projectId, thumbMediaId: "COVER-1", theme: "mist" }, CREDENTIALS);
      assertEqual(second.action, "updated");
      assertEqual(second.theme, "mist");
      assertEqual(getWxPreference(projectId)?.theme, "mist", "带 theme 推送后应存成项目偏好");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("请求里不传 theme 时沿用已存的偏好", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    const projectId = fixtureArticle();
    try {
      await pushDraft({ projectId, thumbMediaId: "COVER-1", theme: "paper" }, CREDENTIALS);
      const second = await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS);
      assertEqual(second.theme, "paper", "第二次没传 theme，应该沿用上一次存的 paper");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("缺稿件和缺正文按输入错误抛，缺封面同样拦在推送之前", async () => {
    const calls: Call[] = [];
    stubWechat(calls);
    clearAccessTokenCache();
    try {
      await pushDraft({ projectId: "prj_not_exist", thumbMediaId: "COVER-1" }, CREDENTIALS).then(
        () => {
          throw new Error("不存在的稿件不该推成功");
        },
        (error: unknown) => {
          assertTrue(error instanceof Error, "应该抛错");
          assertMatch((error as Error).message, /稿件不存在/);
        },
      );

      const empty = createProject({ title: "空稿", topicId: "general" });
      await pushDraft({ projectId: empty.id, thumbMediaId: "COVER-1" }, CREDENTIALS).then(
        () => {
          throw new Error("没有正文不该推成功");
        },
        (error: unknown) => {
          assertMatch((error as Error).message, /正文/);
        },
      );

      const withArticle = fixtureArticle();
      await pushDraft({ projectId: withArticle }, CREDENTIALS).then(
        () => {
          throw new Error("没有封面不该推成功");
        },
        (error: unknown) => {
          assertMatch((error as Error).message, /封面/);
        },
      );

      // 通道检查会取一次 token（那是允许的），但**草稿接口一个都不该碰**。
      assertEqual(draftCalls(calls).length, 0, "输入不合法时不该调任何草稿接口");
      assertEqual(
        calls.filter(call => call.url.includes("/cgi-bin/media/")).length,
        0,
        "输入不合法时不该去上传封面或正文图片",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("微信返回业务错误时抛错，错误信息里不出现 access_token", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/cgi-bin/token")) return jsonResponse({ access_token: "SECRET-TOKEN-VALUE", expires_in: 7200 });
      if (url.includes("/cgi-bin/draft/update")) return jsonResponse({ errcode: 84061, errmsg: "草稿不存在" });
      return jsonResponse({ errcode: 40001, errmsg: "unsupported" });
    }) as typeof globalThis.fetch;
    clearAccessTokenCache();
    try {
      const projectId = fixtureArticle();
      // 手动写一条偏好，模拟"已经推过一次"，让代码走进更新分支
      saveWxPreference({ projectId, draftMediaId: "OLD-MEDIA", draftFingerprint: "old-fingerprint" });

      await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS).then(
        () => {
          throw new Error("微信报错时不该推成功");
        },
        (error: unknown) => {
          assertTrue(error instanceof Error, "应该抛错");
          assertMatch((error as Error).message, /84061|草稿不存在/);
          assertTrue(!((error as Error).message ?? "").includes("SECRET-TOKEN-VALUE"), "错误信息不能带 token");
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("通道没测通就推不出去：一个草稿请求都不该发", async () => {
    // 「先测后发」是硬约束：取 token 失败（IP 白名单没过、凭据不对），
    // 就不能再往下走半步——连正文图片都不该去上传。
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/cgi-bin/token")) {
        return jsonResponse({ errcode: 40164, errmsg: "invalid ip 61.144.242.162, not in whitelist" });
      }
      return jsonResponse({ media_id: "DRAFT-MEDIA-ID" });
    }) as typeof globalThis.fetch;
    clearAccessTokenCache();
    try {
      const projectId = fixtureArticle();
      await pushDraft({ projectId, thumbMediaId: "COVER-1" }, CREDENTIALS).then(
        () => {
          throw new Error("通道没测通时不该推成功");
        },
        (error: unknown) => {
          assertTrue(error instanceof Error, "应该抛错");
          assertMatch((error as Error).message, /还没测通/);
          assertMatch((error as Error).message, /IP 白名单/);
        },
      );
      assertEqual(draftCalls(calls).length, 0, "通道不通时不该调任何草稿接口");
      assertEqual(
        calls.filter(call => call.url.includes("/cgi-bin/media/")).length,
        0,
        "通道不通时不该去上传正文图片",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
