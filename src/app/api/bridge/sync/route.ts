import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { getProject, getStageResult } from "../../../../lib/repo";
import { markdownToPlainText, markdownToWechatHtml } from "../../../../lib/markdown";
import { isPlatform, PLATFORMS } from "../../../../lib/bridge/protocol";
import { getBackendBridge } from "../../../../lib/bridge/backend-client";

export const runtime = "nodejs";

const syncSchema = z.object({
  platform: z.string().trim().min(1).max(40),
  projectId: z.string().trim().min(1).max(80),
});

/**
 * 多平台分发：取稿件的正文，经 WS 桥推给已连接的浏览器扩展。
 *
 * 稿件正文以 Markdown 存在 stage_results（stage=article）里。
 * 推给扩展时给两份：
 * - `content`：纯文本（掘金 Markdown 编辑器、小红书文案栏用）；
 * - `html`：公众号兼容 HTML（知乎、CSDN、飞书富文本编辑器用）。
 * 扩展按平台选择编辑器后填入。扩展找不到编辑器时，通过 syncResult 回 failure，
 * 本接口返回 taskId，由前端轮询 /api/bridge/task 拿最终结果。
 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let body: z.infer<typeof syncSchema>;
  try {
    body = syncSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!isPlatform(body.platform)) {
    return NextResponse.json(
      { error: `不支持的平台：${body.platform}（支持：${PLATFORMS.join("、")}）` },
      { status: 400 },
    );
  }

  const project = getProject(body.projectId);
  if (!project) {
    return NextResponse.json({ error: "稿件不存在" }, { status: 404 });
  }

  const article = getStageResult(body.projectId, "article");
  if (!article || !article.content.trim()) {
    return NextResponse.json({ error: "该稿件还没有正文，无法推送。" }, { status: 400 });
  }

  const title = project.title || markdownToPlainText(article.content).slice(0, 40);
  const html = markdownToWechatHtml(article.content);
  const content = markdownToPlainText(article.content);

  try {
    const bridge = getBackendBridge();
    const { taskId } = await bridge.syncArticle({
      platform: body.platform,
      title,
      content,
      html,
    });
    return NextResponse.json({ ok: true, taskId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "推送失败";
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
