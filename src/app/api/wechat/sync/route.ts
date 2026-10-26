import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { listPublished } from "../../../../lib/wechat";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 同步已发布文章列表。 */
export async function POST() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    const result = await listPublished();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步已发布文章失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
