import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../../../../../lib/auth";
import { STAGES, STAGE_LABELS, type Stage } from "../../../../../../../lib/db";
import { getProject, getStageResult, saveStageResult, updateProject } from "../../../../../../../lib/repo";

export const runtime = "nodejs";

const bodySchema = z.object({
  content: z.string().max(500_000).optional(),
});

/**
 * 签字时正文取哪个值。
 *
 * 传了就用传的；没传就**沿用现有产出**；连现有产出都没有才是空串。
 *
 * 写成 `provided ?? ""` 的话，一次空 body 的调用就会把已经生成的稿子抹掉——
 * 而且不报错，字数与体检都变成「没问题」，这种事最难查。
 */
export function resolveConfirmedContent(
  existing: string | null | undefined,
  provided: string | undefined,
): string {
  return provided ?? existing ?? "";
}

/**
 * 签字确认。
 *
 * 确认之后，这道工序的产出才算定稿：下一道工序会把它当既定事实来用，
 * 稿件的当前阶段也会相应推进。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; stage: string }> }) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const { id, stage } = await params;
  if (!STAGES.includes(stage as Stage)) {
    return NextResponse.json({ error: "未知的阶段" }, { status: 400 });
  }

  let content: string | undefined;
  try {
    const raw = (await request.json()) as unknown;
    const parsed = bodySchema.safeParse(raw ?? {});
    if (parsed.success) content = parsed.data.content;
  } catch {
    // 请求体不是 JSON：按"不改正文、只确认现状"处理。
  }

  try {
    const project = getProject(id);
    if (!project) return NextResponse.json({ error: "稿件不存在" }, { status: 404 });

    // 没传 content 时**沿用现有产出**，不是存空串。
    //
    // 这个接口的语义是「签字确认」，不是「改内容」；不传内容就该只改状态。
    const existing = getStageResult(id, stage as Stage);
    const finalContent = resolveConfirmedContent(existing?.content, content);

    const stageResult = saveStageResult({
      projectId: id,
      stage: stage as Stage,
      content: finalContent,
      status: "confirmed",
    });

    // 推进到下一道工序；已经是最后一道就停在原地。
    const index = STAGES.indexOf(stage as Stage);
    const nextStage = index >= 0 && index < STAGES.length - 1 ? STAGES[index + 1] : undefined;
    const updated = nextStage ? updateProject(id, { stage: nextStage }) : project;

    return NextResponse.json({
      project: updated,
      stageResult,
      nextStage: nextStage ?? null,
      nextStageLabel: nextStage ? STAGE_LABELS[nextStage] : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "确认失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
