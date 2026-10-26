import { NextResponse } from "next/server";
import { requireAuth } from "../../../lib/auth";
import { listInstalledSkills } from "../../../lib/skills";

export const runtime = "nodejs";

/**
 * 本机装好的技能包清单。
 *
 * 界面上要能看见「有哪些技能、各自管什么、里面有哪些文件」，
 * 让「这次启用哪些」变成一个用户看得懂的选择，而不是藏在配置里的开关。
 */
export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json({ skills: await listInstalledSkills() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取技能包失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
