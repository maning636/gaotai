import { NextResponse } from "next/server";
import { createSessionCookie, readSession, verifyBootToken } from "../../../../lib/auth";

export const runtime = "nodejs";

/**
 * 当前是否已登录。
 *
 * 这个接口不设守卫——它存在的意义就是回答"登录了吗"。
 */
export async function GET() {
  const session = await readSession();
  return NextResponse.json({ authenticated: Boolean(session) });
}

/**
 * 用**本次启动的令牌**换一个会话。
 *
 * 桌面客户端启动时随机生成一个令牌，通过环境变量交给后端；
 * 窗口打开前用它调这个接口，拿到会话 cookie 注入浏览器。
 * 于是用户打开程序就是直接进去的，**永远看不到登录页**。
 *
 * 令牌只对当次进程有效（每次启动重新随机，不落盘），
 * 所以这个接口对浏览器里的网页是不可用的——安全边界还在。
 */
export async function POST(request: Request) {
  let token = "";
  try {
    const body = (await request.json()) as { token?: unknown };
    if (typeof body?.token === "string") token = body.token;
  } catch {
    token = "";
  }

  if (!verifyBootToken(token)) {
    return NextResponse.json(
      { error: "启动令牌不对，这个接口只对本次运行的桌面客户端开放。" },
      { status: 403 },
    );
  }

  await createSessionCookie();
  return NextResponse.json({ ok: true, authenticated: true });
}
