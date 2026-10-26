import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../../lib/auth";
import { STAGES, type Stage } from "../../../../lib/db";
import {
  deleteProject,
  getProject,
  getStageResult,
  listMessages,
  listStageResults,
  updateProject,
} from "../../../../lib/repo";

export const runtime = "nodejs";

const patchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  topicId: z.string().trim().min(1).max(80).optional(),
  stage: z.enum(STAGES as [Stage, ...Stage[]]).optional(),
});

/** 取一篇稿件的完整状态。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "稿件不存在" }, { status: 404 });
  try {
    const stages = listStageResults(id);
    return NextResponse.json({
      project,
      stages,
      // 当前阶段的产出单独给一份，页面不用自己从数组里找。
      current: getStageResult(id, project.stage),
      messages: listMessages(id),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取稿件失败" },
      { status: 500 },
    );
  }
}

/** 改稿件信息。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  const { id } = await params;
  try {
    const body = patchSchema.parse(await request.json());
    const project = updateProject(id, body);
    if (!project) return NextResponse.json({ error: "稿件不存在" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    const message = error instanceof Error ? error.message : "修改稿件失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** 删除稿件。 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const ok = deleteProject(id);
  if (!ok) return NextResponse.json({ error: "稿件不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
