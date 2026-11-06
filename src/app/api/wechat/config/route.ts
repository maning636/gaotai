import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import {
  maskAppId,
  readWechatAccounts,
  readWechatCredentials,
  readWechatCover,
  saveWechatAccounts,
  saveWechatCredentials,
  toAccountViews,
  MAX_WECHAT_ACCOUNTS,
} from "../../../../lib/wechat-config";

export const runtime = "nodejs";

const bodySchema = z.object({
  appId: z.string().trim().min(1, "请填写 AppID").max(80),
  appSecret: z.string().trim().min(1, "请填写 AppSecret").max(120),
});

const accountSchema = z.object({
  id: z.string().trim().max(80).optional(),
  name: z.string().trim().max(60),
  appId: z.string().trim().min(1, "请填写 AppID").max(80),
  appSecret: z.string().trim().min(1, "请填写 AppSecret").max(120),
});

const accountsSchema = z.object({
  accounts: z.array(accountSchema).max(MAX_WECHAT_ACCOUNTS, `公众号账号最多保存 ${MAX_WECHAT_ACCOUNTS} 个。`),
});

/** 公众号配置状态。AppSecret 永远不会返回。 */
export async function GET() {
  const blocked = await guard();
  if (blocked) return blocked;
  const { appId, appSecret } = readWechatCredentials();
  const cover = readWechatCover();
  return NextResponse.json({
    configured: Boolean(appId && appSecret),
    appIdMasked: maskAppId(appId),
    coverConfigured: Boolean(cover.mediaId),
    accounts: toAccountViews(readWechatAccounts()),
  });
}

/** 保存公众号配置（写进 .env）。 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const body = bodySchema.parse(await request.json());
    await saveWechatCredentials({ appId: body.appId, appSecret: body.appSecret });
    return NextResponse.json({ ok: true, appIdMasked: maskAppId(body.appId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存公众号配置失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * 保存多账号清单（整体覆盖）。
 *
 * 单独一个 PUT 而不是复用 POST——POST 是「保存默认账号」，两件事的
 * 请求体形状不一样，混在一起容易改坏. 账号清单的 secret 同样只进 .env。
 */
export async function PUT(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const body = accountsSchema.parse(await request.json());
    const saved = await saveWechatAccounts(
      body.accounts.map(account => ({
        id: account.id ?? "",
        name: account.name,
        appId: account.appId,
        appSecret: account.appSecret,
      })),
    );
    return NextResponse.json({ ok: true, accounts: toAccountViews(saved) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存账号失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
