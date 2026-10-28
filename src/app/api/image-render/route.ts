import { NextResponse } from "next/server";
import { z } from "zod";
import { renderCard } from "../../../lib/image-renderer";
import { guard } from "../../../lib/license/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

const renderSchema = z.object({
  title: z.string().min(1).max(60),
  subtitle: z.string().max(120).optional(),
  tag: z.string().max(24).optional(),
  accent: z.enum(["pink", "yellow", "blue", "green"]).optional(),
  width: z.number().min(400).max(2000).optional(),
  height: z.number().min(300).max(1500).optional(),
});

// 把视觉提示词程序化渲染成 PNG 卡片，落到 .tmp/images/ 目录，返回 URL 供文章引用。
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const spec = renderSchema.parse(await request.json());
    const result = await renderCard(spec);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "图片渲染失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
