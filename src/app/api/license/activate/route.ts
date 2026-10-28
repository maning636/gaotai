import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { activate } from "../../../../lib/license/client";
import { getMachineId } from "../../../../lib/license/machine";
import { writeTokenCache } from "../../../../lib/license/store";
import { licenseSnapshot, resetLicenseCache } from "../../../../lib/license/gate";
import { httpStatusFor } from "../../../../lib/license/types";
import { ensureAssets } from "../../../../lib/assets/sync";

export const runtime = "nodejs";

/**
 * POST /api/license/activate
 *
 * body `{ code }`：调服务端激活，成功则写缓存并刷新 gate 缓存，返回 `{ license, machine }`。
 * 失败返回 `{ error, code, message }`，HTTP 状态按契约错误码映射（400/403/404/429/503）。
 * 错误响应里不回显 token。
 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  let code = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body?.code === "string") code = body.code.trim();
  } catch {
    return NextResponse.json(
      { error: "请求体格式错误。", code: "bad_request", message: "请求体格式错误。" },
      { status: 400 },
    );
  }

  if (!code) {
    return NextResponse.json(
      { error: "请输入注册码。", code: "bad_request", message: "请输入注册码。" },
      { status: 400 },
    );
  }

  const machine = await getMachineId();
  const result = await activate({ code, machine });

  if (!result.ok) {
    const status = httpStatusFor(result.error.code);
    return NextResponse.json(
      { error: result.error.message, code: result.error.code, message: result.error.message },
      { status },
    );
  }

  // 成功：写缓存，刷新 gate 进程内缓存
  const data = result.data;
  await writeTokenCache({
    token: data.token,
    expiresAt: data.expiresAt,
    machine,
    code: data.code,
    features: data.features,
    plan: data.plan,
  });
  resetLicenseCache();

  // 激活成功后立即同步四类资产（force：强制拉 manifest 比对）。
  // 失败不影响激活——资源包稍后可经 POST /api/license/sync 或下次启动重试。
  let assets: { status: string; version?: string } = { status: "skipped" };
  try {
    const assetResult = await ensureAssets({ force: true });
    assets = { status: assetResult.status, version: "version" in assetResult ? assetResult.version : undefined };
    if (assetResult.status === "failed") {
      console.warn("[gaotai] 激活后资产同步失败：", assetResult.error);
    }
  } catch (error) {
    console.warn("[gaotai] 激活后资产同步异常（不影响激活）：", error);
  }

  const snapshot = await licenseSnapshot();
  return NextResponse.json({ license: snapshot, machine, assets });
}
