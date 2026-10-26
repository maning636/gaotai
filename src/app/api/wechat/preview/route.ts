import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { resolveTemplateForProject } from "../../../../lib/layout-store";
import { getProject, getStageResult, saveWxPreference } from "../../../../lib/repo";
import { markdownToPlainText, markdownToWechatHtml } from "../../../../lib/markdown";

export const runtime = "nodejs";

/**
 * 公众号预览。
 *
 * 返回的是能直接粘进公众号编辑器的 HTML——没有 class，只有行内样式。
 * 同时给一份纯文本：剪贴板里两种格式各写一份，贴到哪都能用。
 *
 * 排版用哪套模板，按「本次请求 > 这篇稿子记着的 > 内置默认」三档取。
 * 请求带了 templateId 或 theme 就顺手记成偏好，下一步推草稿时不用再传。
 */
export async function GET(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const params = new URL(request.url).searchParams;
  const projectId = params.get("projectId")?.trim();
  if (!projectId) return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });

  try {
    const project = getProject(projectId);
    if (!project) return NextResponse.json({ error: "稿件不存在" }, { status: 404 });

    const article = getStageResult(projectId, "article");
    if (!article?.content.trim()) {
      return NextResponse.json({ error: "这篇稿子还没有正文，先把文章正文这一步走完。" }, { status: 400 });
    }

    const rawTheme = params.get("theme");
    const rawTemplateId = params.get("templateId");
    const resolved = resolveTemplateForProject(projectId, {
      templateId: rawTemplateId,
      theme: rawTheme,
    });

    if (rawTheme !== null || rawTemplateId !== null) {
      saveWxPreference({
        projectId,
        templateId: resolved.templateId,
        ...(resolved.theme ? { theme: resolved.theme } : {}),
      });
    }

    const html = markdownToWechatHtml(article.content, {
      template: resolved.template,
      decorateImages: true,
    });
    return NextResponse.json({
      html,
      text: markdownToPlainText(article.content),
      title: project.title,
      theme: resolved.theme ?? "default",
      templateId: resolved.templateId,
      templateName: resolved.template.name,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成预览失败" },
      { status: 500 },
    );
  }
}
