import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { listLoginFailures } from "../../../../lib/login-audit";

export const runtime = "nodejs";

/** 最近登录失败记录。 */
export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json({ failures: await listLoginFailures(100) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取登录记录失败" },
      { status: 500 },
    );
  }
}
