import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { getArticleStats } from "../../../../lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 已发布文章的阅读/在看/分享/评论数据。 */
export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json({ stats: await getArticleStats() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "拉取统计数据失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
