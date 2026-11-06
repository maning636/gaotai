import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { generateImage } from "../../../../lib/ai-image/generate";
import { getStylePrompt } from "../../../../lib/ai-image/styles";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(1000),
  style: z.string().trim().max(40).optional(),
  size: z.enum(["256x256", "512x512", "1024x1024"]).optional(),
  n: z.number().int().min(1).max(4).optional(),
});

/**
 * AI 生图代理。
 *
 * 前端不接触模型 apiKey：密钥在 generateImage() 里读模型配置，这里只转发。
 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "参数不对";
    return NextResponse.json({ error: `生图参数不对：${message}` }, { status: 400 });
  }

  try {
    const prompt = getStylePrompt(body.style ?? "custom", body.prompt);
    const images = await generateImage({
      prompt,
      size: body.size ?? "1024x1024",
      n: body.n ?? 1,
    });
    return NextResponse.json({ images });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 生图失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
