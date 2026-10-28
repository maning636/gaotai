import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../lib/license/guard";
import { parseLayoutPack } from "../../../lib/layout-template";

export const runtime = "nodejs";

/**
 * 导入排版样式包。
 *
 * 样式包是外部来的 JSON：一份「我这几个部件长什么样」的说明。
 * 这里只做两件事——解析、清洗，**不落库**。
 *
 * 不落库是刻意的：包进来之后还要逐个部件取舍、改名、调色，
 * 那是「排版模板」页上的活。接口只负责把包读成一个能编辑的模板草稿，
 * 剩下的交给人。直接一把导入就存库，等于把包的作者偏好硬塞给用户。
 */

const bodySchema = z.object({
  text: z.string().min(1, "样式包内容不能为空。").max(400_000),
});

export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  try {
    const body = bodySchema.parse(await request.json());
    const { template, warnings } = parseLayoutPack(body.text);
    return NextResponse.json({ template, warnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "样式包解析失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
