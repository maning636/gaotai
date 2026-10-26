import { NextResponse } from "next/server";
import { clearSessionCookie } from "../../../../lib/auth";

export const runtime = "nodejs";

/** 退出登录：清掉会话 cookie。 */
export async function POST() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
