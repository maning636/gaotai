import { NextResponse } from "next/server";
import { createSessionCookie, hasConfiguredPassword, passwordMatches } from "../../../../lib/auth";
import { countRecentFailures, recordLoginFailure } from "../../../../lib/login-audit";

export const runtime = "nodejs";

/**
 * 登录。
 *
 * 口令本身存在 .env 的 APP_PASSWORD 里（首次运行时随机生成）。
 * 连续失败会先记审计日志；失败次数过多时直接拒绝，
 * 免得被人拿脚本慢慢试。
 */

const MAX_FAILURES_IN_WINDOW = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: Request) {
  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body?.password === "string") password = body.password;
  } catch {
    return NextResponse.json({ error: "请求体格式错误。" }, { status: 400 });
  }

  if (!password) {
    return NextResponse.json({ error: "请输入登录口令。" }, { status: 400 });
  }

  // 应用还没初始化完成（.env 没生成）时要说清楚是哪种问题，
  // 否则用户只会看到「口令不正确」，然后一直重试。
  if (!hasConfiguredPassword()) {
    return NextResponse.json(
      { error: "应用尚未完成初始化：本地 .env 里没有登录口令。请确认程序正常启动过。" },
      { status: 500 },
    );
  }

  const recent = await countRecentFailures(FAILURE_WINDOW_MS);
  if (recent >= MAX_FAILURES_IN_WINDOW) {
    return NextResponse.json(
      { error: "短时间内失败次数过多，请稍后再试。" },
      { status: 429 },
    );
  }

  if (!passwordMatches(password)) {
    await recordLoginFailure(request);
    return NextResponse.json({ error: "口令不正确。" }, { status: 401 });
  }

  await createSessionCookie();
  return NextResponse.json({ ok: true });
}
