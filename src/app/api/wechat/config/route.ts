import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../../lib/auth";
import { maskAppId, readWechatCredentials, readWechatCover, saveWechatCredentials } from "../../../../lib/wechat-config";

export const runtime = "nodejs";

const bodySchema = z.object({
  appId: z.string().trim().min(1, "请填写 AppID").max(80),
  appSecret: z.string().trim().min(1, "请填写 AppSecret").max(120),
});

/** 公众号配置状态。AppSecret 永远不会返回。 */
export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  const { appId, appSecret } = readWechatCredentials();
  const cover = readWechatCover();
  return NextResponse.json({
    configured: Boolean(appId && appSecret),
    appIdMasked: maskAppId(appId),
    coverConfigured: Boolean(cover.mediaId),
  });
}

/** 保存公众号配置（写进 .env）。 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    const body = bodySchema.parse(await request.json());
    await saveWechatCredentials({ appId: body.appId, appSecret: body.appSecret });
    return NextResponse.json({ ok: true, appIdMasked: maskAppId(body.appId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存公众号配置失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
