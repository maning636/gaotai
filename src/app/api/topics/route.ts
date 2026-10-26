import { NextResponse } from "next/server";
import { requireAuth } from "../../../lib/auth";
import { listTopics } from "../../../lib/topics";

export const runtime = "nodejs";

/** 列出全部专题（公开 + 本地，本地覆盖同 id 的公开专题）。 */
export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json({ topics: await listTopics() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取专题失败" },
      { status: 500 },
    );
  }
}
