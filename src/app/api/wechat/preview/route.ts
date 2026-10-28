import { NextResponse } from "next/server";
import { guard } from "../../../../lib/license/guard";
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
 *
 * GET 读数据库里已保存的正文；POST 可以带一份编辑器里的当前正文——
 * 图刚插进去、还没点「保存修改」时，预览也能看到它，不会出现
 * 「编辑器里有图、预览里没有」。
 */

type PreviewInput = {
  projectId: string;
  templateId?: string;
  theme?: string;
  /** 编辑器里的当前正文。给了就以它为准（未保存的改动也能预览）。 */
  contentOverride?: string;
  /** 是否把本次模板选择记成这篇稿子的偏好。 */
  remember: boolean;
};

function buildPreview(input: PreviewInput) {
  const { projectId } = input;
  if (!projectId) {
    return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
  }

  try {
    const project = getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: "稿件不存在" }, { status: 404 });
    }

    const saved = getStageResult(projectId, "article");
    const content = (input.contentOverride ?? saved?.content ?? "").trim();
    if (!content) {
      return NextResponse.json(
        { error: "这篇稿子还没有正文，先把文章正文这一步走完。" },
        { status: 400 },
      );
    }
    if (content.length > 2_000_000) {
      return NextResponse.json({ error: "正文过长，无法预览。" }, { status: 413 });
    }

    const resolved = resolveTemplateForProject(projectId, {
      templateId: input.templateId,
      theme: input.theme,
    });

    if (input.remember) {
      saveWxPreference({
        projectId,
        templateId: resolved.templateId,
        ...(resolved.theme ? { theme: resolved.theme } : {}),
      });
    }

    const html = markdownToWechatHtml(content, {
      template: resolved.template,
      decorateImages: true,
    });
    return NextResponse.json({
      html,
      text: markdownToPlainText(content),
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

export async function GET(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  const params = new URL(request.url).searchParams;
  const templateId = params.get("templateId") ?? undefined;
  const theme = params.get("theme") ?? undefined;
  return buildPreview({
    projectId: params.get("projectId")?.trim() ?? "",
    templateId,
    theme,
    remember: templateId !== undefined || theme !== undefined,
  });
}

export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let body: {
    projectId?: string;
    templateId?: string;
    theme?: string;
    content?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const templateId = typeof body.templateId === "string" ? body.templateId : undefined;
  const theme = typeof body.theme === "string" ? body.theme : undefined;
  return buildPreview({
    projectId: body.projectId?.trim() ?? "",
    templateId,
    theme,
    contentOverride: typeof body.content === "string" ? body.content : undefined,
    remember: templateId !== undefined || theme !== undefined,
  });
}
