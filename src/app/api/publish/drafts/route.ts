import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { listDrafts, createDraft } from "../../../../lib/repo";

export const runtime = "nodejs";

const createSchema = z.object({
  title: z.string().trim().max(200).default(""),
  content: z.string().max(50000).default(""),
  category: z.string().trim().max(50).default("general"),
  projectId: z.string().trim().optional(),
});

/**
 * 文案列表与新建。
 *
 * 文案是「写好了但还没插进稿子」的片段：一段开头、一组金句、一段产品介绍。
 * 落 SQLite 而不是文件——要按分类筛选、要关联稿件，这些都是数据库的活。
 */

/** 列出文案。可选按分类筛选。 */
export async function GET(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  const url = new URL(request.url);
  const category = url.searchParams.get("category")?.trim() || undefined;
  return NextResponse.json({ drafts: listDrafts(category ? { category } : {}) });
}

/** 新建一条文案。title 和 content 至少有一个非空。 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (!body.title && !body.content) {
    return NextResponse.json({ error: "标题和正文至少填一个。" }, { status: 400 });
  }
  const draft = createDraft({
    title: body.title,
    content: body.content,
    category: body.category || "general",
    ...(body.projectId ? { projectId: body.projectId } : {}),
  });
  return NextResponse.json({ ok: true, draft }, { status: 201 });
}
