import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { extractImageTopics } from "../../../../lib/ai-image/topic-extract";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  text: z.string().max(200_000),
});

/** 从文章正文提取适合做配图的主题关键词。 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "参数不对";
    return NextResponse.json({ error: `正文参数不对：${message}` }, { status: 400 });
  }

  try {
    const topics = await extractImageTopics(body.text);
    return NextResponse.json({ topics });
  } catch (error) {
    const message = error instanceof Error ? error.message : "提取主题失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
