import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../lib/auth";
import { createProject, listProjects } from "../../../lib/repo";

export const runtime = "nodejs";

const createSchema = z.object({
  title: z.string().trim().max(200).optional(),
  topicId: z.string().trim().min(1).max(80),
});

/** 稿件列表。 */
export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json({ projects: listProjects() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取稿件列表失败" },
      { status: 500 },
    );
  }
}

/** 新建稿件。 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    const body = createSchema.parse(await request.json());
    const project = createProject({ title: body.title ?? "", topicId: body.topicId });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "新建稿件失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
