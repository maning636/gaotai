import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../lib/license/guard";
import { getEditCount, getStyleProfile, refreshStyleProfile } from "../../../lib/style-memory";

export const runtime = "nodejs";

const bodySchema = z.object({
  topicId: z.string().trim().min(1).max(80),
});

/** 读某个专题的风格画像与修改次数。 */
export async function GET(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  const topicId = new URL(request.url).searchParams.get("topicId")?.trim();
  if (!topicId) return NextResponse.json({ error: "缺少 topicId" }, { status: 400 });
  try {
    const [profile, editCount] = await Promise.all([getStyleProfile(topicId), getEditCount(topicId)]);
    return NextResponse.json({ topicId, profile, editCount });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取风格画像失败" },
      { status: 500 },
    );
  }
}

/** 重新分析并保存风格画像。 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const body = bodySchema.parse(await request.json());
    const analysis = await refreshStyleProfile(body.topicId);
    if (!analysis) {
      const count = await getEditCount(body.topicId);
      return NextResponse.json(
        { error: `修改记录还不够（当前 ${count} 条），再多改几处就能提炼出风格画像。` },
        { status: 400 },
      );
    }
    return NextResponse.json({ profile: analysis.profile, metrics: analysis.metrics, editCount: analysis.editCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成风格画像失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
