import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../../lib/auth";
import { maskAppId, readWechatCredentials } from "../../../../lib/wechat-config";
import { checkWechatConnection } from "../../../../lib/wechat-check";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  /** 临时指定要测的 AppID。不传就测 .env 里存的那份。 */
  appId: z.string().trim().max(80).optional(),
  /** 临时指定要测的 AppSecret。不传就测 .env 里存的那份。 */
  appSecret: z.string().trim().max(120).optional(),
});

/**
 * 测试公众号通道通不通。
 *
 * **只测不存**：填了新的 AppID / AppSecret 想先试试，行；
 * 但真要保存，点「保存配置」——不让测试动作偷偷改掉用户存着的凭据。
 *
 * 返回 200 就算「测试本身成功执行了」；通没通过看 body 里的 `ok`。
 * 「测试不通过」是一个有效结果，不是请求出错，所以不用 4xx。
 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  let body: z.infer<typeof bodySchema> = {};
  try {
    const text = await request.text();
    if (text.trim()) body = bodySchema.parse(JSON.parse(text));
  } catch {
    // 请求体格式不对就按「测已保存的那份」处理，
    // 免得一个手滑的按钮把整条通道卡住。
  }

  const saved = readWechatCredentials();
  const appId = body.appId || saved.appId;
  const appSecret = body.appSecret || saved.appSecret;

  if (!appId || !appSecret) {
    return NextResponse.json({
      ok: false,
      reason: "还没有填公众号凭据",
      hint: "把 AppID 和 AppSecret 填进上面的输入框，再点一次「测试连接」。",
    });
  }

  const result = await checkWechatConnection({ appId, appSecret });
  return NextResponse.json({
    ...result,
    appIdMasked: maskAppId(appId),
    checkedAt: new Date().toISOString(),
  });
}
