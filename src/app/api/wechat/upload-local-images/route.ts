import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { getStageResult } from "../../../../lib/repo";
import { cdnizeLocalImages } from "../../../../lib/wechat-images";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  /** 要处理哪篇稿件的正文。不传就直接用下面的 markdown。 */
  projectId: z.string().trim().min(1).optional(),
  /** 直接给一段 Markdown 处理。 */
  markdown: z.string().optional(),
});

/**
 * 上传正文里引用的本机图片，换成微信自己的图片地址。
 *
 * 公众号正文里的图片必须是微信能访问到的地址，本机路径在公众号里显示不出来。
 * 这里把正文里出现的本机图片逐张上传，返回换好地址的正文与逐张明细。
 *
 * 推草稿走的是同一条逻辑（见 /api/wechat/draft），这个接口单独暴露出来，
 * 是为了「复制到剪贴板」这类需要先拿到成品 HTML 的场景。
 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    let markdown = body.markdown ?? "";
    if (!body.markdown) {
      if (!body.projectId) {
        return NextResponse.json({ error: "请提供 projectId 或 markdown。" }, { status: 400 });
      }
      const article = getStageResult(body.projectId, "article");
      if (!article?.content.trim()) {
        return NextResponse.json({ error: "这篇稿子还没有正文。" }, { status: 400 });
      }
      markdown = article.content;
    }

    const report = await cdnizeLocalImages(markdown);
    return NextResponse.json({
      ok: true,
      markdown: report.markdown,
      uploaded: report.uploaded,
      failed: report.failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "上传图片失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
