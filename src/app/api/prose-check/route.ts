import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../lib/license/guard";
import { checkProse, renderProseReport } from "../../../lib/prose-check";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** 要检查的正文。 */
  content: z.string().max(500_000),
});

/**
 * 成稿体检。
 *
 * 查的是硬禁令（冒号、破折号、翻案句、硬停词、绝对禁用黑话、模型路标）
 * 与「像模型写出来的」形状信号。只报警，不改文。
 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let content: string;
  try {
    const body = bodySchema.parse(await request.json());
    content = body.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = checkProse(content);
    return NextResponse.json({ ...result, report: renderProseReport(result) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "体检失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
