import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { resolveTemplateForProject, templateIdForTheme } from "../../../../lib/layout-store";
import { getWxPreference, saveWxPreference } from "../../../../lib/repo";
import { normalizeThemeId } from "../../../../lib/wx-theme";

export const runtime = "nodejs";

/**
 * 公众号排版选择的读写。
 *
 * 单独一个接口，而不是塞进预览接口：
 * 预览是一次渲染（要排整篇），而「这篇稿子用哪套排版」是个很小的状态，
 * 面板每换一篇稿子就要问一次，不该顺带渲染一遍。
 *
 * 读的时候回退 default：没选过就是默认那套，不是错误。
 */
export async function GET(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const projectId = new URL(request.url).searchParams.get("projectId")?.trim();
  if (!projectId) return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });

  try {
    const stored = getWxPreference(projectId);
    const theme = normalizeThemeId(stored?.theme);
    const templateId = stored?.template_id || templateIdForTheme(theme);
    return NextResponse.json({ theme, templateId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取排版失败" },
      { status: 500 },
    );
  }
}

/** 记下这篇稿子用哪套排版。 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as { projectId?: string; theme?: string; templateId?: string };
    const projectId = body.projectId?.trim();
    if (!projectId) return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });

    // 带了 templateId 就按模板走；没带才按 theme 找内置配色。
    if (body.templateId?.trim()) {
      const templateId = body.templateId.trim();
      const resolved = resolveTemplateForProject(projectId, { templateId });
      saveWxPreference({
        projectId,
        templateId: resolved.templateId,
        ...(resolved.theme ? { theme: resolved.theme } : {}),
      });
      return NextResponse.json({ theme: resolved.theme ?? "default", templateId: resolved.templateId });
    }

    const theme = normalizeThemeId(body.theme);
    saveWxPreference({ projectId, theme, templateId: templateIdForTheme(theme) });
    return NextResponse.json({ theme, templateId: templateIdForTheme(theme) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存排版失败" },
      { status: 500 },
    );
  }
}
