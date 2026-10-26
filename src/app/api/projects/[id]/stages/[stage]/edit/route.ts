import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../../../../../lib/auth";
import { STAGES, type Stage } from "../../../../../../../lib/db";
import { recordEdit } from "../../../../../../../lib/repo";

export const runtime = "nodejs";

const bodySchema = z.object({
  before: z.string().max(500_000),
  after: z.string().max(500_000),
});

/**
 * 记录一次人工修改。
 *
 * 这是风格画像的唯一证据来源，所以前后文本都存原文，不做归一化——
 * 风格分析需要看到真实笔迹，包括标点。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; stage: string }> }) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const { id, stage } = await params;
  if (!STAGES.includes(stage as Stage)) {
    return NextResponse.json({ error: "未知的阶段" }, { status: 400 });
  }

  try {
    const body = bodySchema.parse(await request.json());
    if (body.before === body.after) {
      return NextResponse.json({ error: "内容没有变化，不算一次修改。" }, { status: 400 });
    }
    const edit = recordEdit({ projectId: id, stage: stage as Stage, beforeText: body.before, afterText: body.after });
    return NextResponse.json({ edit }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "记录修改失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
