import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../../lib/license/guard";
import { getDraft, updateDraft, deleteDraft } from "../../../../../lib/repo";

export const runtime = "nodejs";

const updateSchema = z.object({
  title: z.string().trim().max(200).optional(),
  content: z.string().max(50000).optional(),
  category: z.string().trim().max(50).optional(),
  projectId: z.string().trim().nullable().optional(),
});

/**
 * 文案单条操作：读一条、改一条、删一条。
 */

/** 取一条文案。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = await guard();
  if (blocked) return blocked;
  const { id } = await params;
  const draft = getDraft(id);
  if (!draft) return NextResponse.json({ error: "文案不存在。" }, { status: 404 });
  return NextResponse.json({ draft });
}

/** 改一条文案。只改传了的字段。 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = await guard();
  if (blocked) return blocked;
  const { id } = await params;
  let body: z.infer<typeof updateSchema>;
  try {
    body = updateSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const draft = updateDraft(id, body);
  if (!draft) return NextResponse.json({ error: "文案不存在。" }, { status: 404 });
  return NextResponse.json({ ok: true, draft });
}

/** 删一条文案。 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = await guard();
  if (blocked) return blocked;
  const { id } = await params;
  if (!deleteDraft(id)) return NextResponse.json({ error: "文案不存在。" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
