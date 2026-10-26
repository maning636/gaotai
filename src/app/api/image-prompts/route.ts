import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../lib/auth";
import { buildImagePrompt } from "../../../lib/stage-engine";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  article: z.string().max(200_000).optional(),
  index: z.number().int().min(0).max(50).optional(),
});

/** 为文章生成一段配图的视觉提示词。 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    const body = bodySchema.parse(await request.json());
    const prompt = await buildImagePrompt({
      title: body.title,
      article: body.article ?? "",
      index: body.index ?? 0,
    });
    return NextResponse.json({ prompt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成配图提示词失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
