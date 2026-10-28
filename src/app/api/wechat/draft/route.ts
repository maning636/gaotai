import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { getProject, getStageResult, getWxPreference, saveWxPreference } from "../../../../lib/repo";
import { extractSummary, extractTitle, markdownToWechatHtml, type ThemeId } from "../../../../lib/markdown";
import { resolveTemplateForProject } from "../../../../lib/layout-store";
import { readWechatCover, type WechatCredentials } from "../../../../lib/wechat-config";
import { cdnizeLocalImages } from "../../../../lib/wechat-images";
import { checkWechatConnection } from "../../../../lib/wechat-check";
import { createDraft, updateDraft } from "../../../../lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().max(200).optional(),
  digest: z.string().trim().max(500).optional(),
  author: z.string().trim().max(60).optional(),
  /** 临时指定封面。不传就用公众号页面上配好的那张。 */
  thumbMediaId: z.string().trim().max(200).optional(),
  /** 排版主题。没传就沿用这个稿件之前存的偏好，再没有就用 default。 */
  theme: z.string().trim().optional(),
  /** 排版模板。传了就按这套模板排版；没传才看 theme。 */
  templateId: z.string().trim().optional(),
});

type Body = z.infer<typeof bodySchema>;

/**
 * 推送到草稿箱。
 *
 * 推之前有两件事必须做对，否则推上去的稿子是坏的：
 * 1. 封面——草稿必须带 thumb_media_id，它是微信永久素材的 id，界面上配好的封面会自动带上；
 * 2. 正文图片——本机地址公众号访问不到，必须逐张换成微信自己的图片地址。
 *
 * 推上去之后由用户自己在公众号后台预览和发布——稿台不代替人点发布。
 *
 * 同一篇稿子推第二次不再新建草稿：按标题和正文的指纹判断内容有没有变，
 * 没变就原样返回之前那份的 media_id，变了就 update 那一份。否则用户手抖连点
 * 两次，草稿箱里就躺着两份一模一样的稿子，得自己去后台删。
 */

/** 输入层面的错误，带 HTTP 状态码：缺稿件是 404，缺正文或缺封面是 400。 */
export class DraftInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "DraftInputError";
  }
}

/** 这次推送实际做了哪件事，调用方拿它提示用户。 */
export type DraftAction = "created" | "unchanged" | "updated";

export type DraftPushResult = {
  ok: true;
  mediaId: string;
  title: string;
  digest: string;
  uploadedImages: number;
  failedImages: { ref: string; reason: string }[];
  /** 这次的动作：新建 / 未变化没重推 / 更新已有那份。 */
  action: DraftAction;
  theme: ThemeId;
  /** 实际用的排版模板 id。 */
  templateId: string;
};

/**
 * 渲染正文并按指纹决定新建还是更新。
 *
 * 单独导出成一个纯函数（只做数据库读写 + 微信调用，不做鉴权和 JSON 解析），
 * 是为了让三条分支能在测试里直接驱动——直接打 POST 得先过登录守卫，
 * 而登录靠 next/headers 的请求上下文，在单测里搭不起来。
 */
export async function pushDraft(input: Body, creds?: WechatCredentials): Promise<DraftPushResult> {
  const project = getProject(input.projectId);
  if (!project) throw new DraftInputError("稿件不存在", 404);

  const article = getStageResult(input.projectId, "article");
  if (!article?.content.trim()) {
    throw new DraftInputError("这篇稿子还没有正文，无法推送。");
  }

  // 先测通道通不通，通不过就不推。
  //
  // 这是**硬闸门**，不是界面上的提示：直接打这个接口也一样推不出去。
  // 「先测后发」这句话的意思就是——没测通的东西不许发。
  //
  // 放在封面检查**之前**：封面要上传到微信的永久素材库才能拿到 media_id，
  // 没通道时封面这一步根本做不了。先说更根本的那个，用户少绕一圈。
  //
  // 取 token 有两小时的有效期并被缓存，所以这一步几乎不额外发请求：
  // 刚测过就推，token 是缓存里那一份。
  const check = await checkWechatConnection(creds);
  if (!check.ok) {
    throw new DraftInputError(`公众号还没测通：${check.reason}。${check.hint}`);
  }

  const cover = readWechatCover();
  const thumbMediaId = input.thumbMediaId?.trim() || cover.mediaId;
  if (!thumbMediaId) {
    throw new DraftInputError("还没有封面图。公众号草稿必须带封面，请先到「公众号」页面上传一张封面。");
  }

  // 排版优先级：本次请求 > 这个稿件存过的偏好 > 内置默认。
  // 请求里带了 templateId 或 theme 就顺手记成偏好，下次不用再传。
  const stored = getWxPreference(input.projectId);
  const resolved = resolveTemplateForProject(input.projectId, {
    templateId: input.templateId,
    theme: input.theme,
  });
  if (input.templateId !== undefined || input.theme !== undefined) {
    saveWxPreference({
      projectId: input.projectId,
      templateId: resolved.templateId,
      ...(resolved.theme ? { theme: resolved.theme } : {}),
    });
  }

  // 正文里的本机图片换成微信地址；个别失败不阻断整篇，失败项在响应里如实报回。
  const images = await cdnizeLocalImages(article.content);
  const html = markdownToWechatHtml(images.markdown, {
    template: resolved.template,
    decorateImages: true,
  });
  const title = input.title || extractTitle(images.markdown) || project.title;
  const digest = input.digest || extractSummary(images.markdown);

  const fingerprint = draftFingerprint(title, html);
  // 复用上面那次读取：saveWxPreference 只覆盖显式传入的字段，
  // 不动 draft_media_id / draft_fingerprint，所以这里不用再查一次。
  const existing = stored;

  // 分支一：这个稿件还没推过草稿，或者记录里没有 media_id——新建。
  if (!existing || !existing.draft_media_id) {
    const result = await createDraft({
      title,
      content: html,
      digest,
      author: input.author,
      thumbMediaId,
      creds,
    });
    saveWxPreference({
      projectId: input.projectId,
      templateId: resolved.templateId,
      ...(resolved.theme ? { theme: resolved.theme } : {}),
      draftMediaId: result.mediaId,
      draftFingerprint: fingerprint,
    });
    return {
      ok: true,
      mediaId: result.mediaId,
      title,
      digest,
      uploadedImages: images.uploaded,
      failedImages: images.failed,
      action: "created",
      theme: resolved.theme ?? "default",
      templateId: resolved.templateId,
    };
  }

  // 分支二：指纹一致说明内容没变——什么都不推，直接回那份草稿的 media_id。
  // 这是防重复的关键：不判断这一步，连点两次就会多出两份一样的草稿。
  if (existing.draft_fingerprint === fingerprint) {
    return {
      ok: true,
      mediaId: existing.draft_media_id,
      title,
      digest,
      uploadedImages: images.uploaded,
      failedImages: images.failed,
      action: "unchanged",
      theme: resolved.theme ?? "default",
      templateId: resolved.templateId,
    };
  }

  // 分支三：内容变了——更新原来那份，而不是新建。index: 0 因为我们只推单篇。
  const result = await updateDraft({
    mediaId: existing.draft_media_id,
    title,
    content: html,
    digest,
    author: input.author,
    thumbMediaId,
    creds,
  });
  saveWxPreference({
    projectId: input.projectId,
    templateId: resolved.templateId,
    ...(resolved.theme ? { theme: resolved.theme } : {}),
    draftMediaId: result.mediaId,
    draftFingerprint: fingerprint,
  });
  return {
    ok: true,
    mediaId: result.mediaId,
    title,
    digest,
    uploadedImages: images.uploaded,
    failedImages: images.failed,
    action: "updated",
    theme: resolved.theme ?? "default",
    templateId: resolved.templateId,
  };
}

/**
 * 草稿指纹：标题和排版后正文的 sha256。
 *
 * 标题也要算进去——公众号里标题改了、正文一个字没动，那篇稿子照样算变了，
 * 只哈希正文会漏掉这种情况。用 JSON.stringify 而不是手拼分隔符：
 * 标题或正文里出现分隔符时不会撞出相同摘要。
 */
function draftFingerprint(title: string, html: string): string {
  return createHash("sha256").update(JSON.stringify({ title, html })).digest("hex");
}

export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let body: Body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    return NextResponse.json(await pushDraft(body));
  } catch (error) {
    // 输入类错误用错误自己带的状态码（400/404），其余一律 500。
    const message = error instanceof Error ? error.message : "推送草稿失败";
    const status = error instanceof DraftInputError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
