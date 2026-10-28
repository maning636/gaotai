import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { assetLocalState } from "../../../../lib/assets/sync";
import { licenseSnapshot } from "../../../../lib/license/gate";
import { getMachineId } from "../../../../lib/license/machine";

export const runtime = "nodejs";

/**
 * GET /api/license/status
 *
 * 返回当前授权快照与本机机器码，供激活页 / 设置页展示。
 * 不含 token，code 已打码。附带资产本地状态（version / ready），
 * 供激活卡展示「资源包 v{version} 已就绪」或「未就绪 · 同步」。
 */
export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const [snapshot, machine, assets] = await Promise.all([
    licenseSnapshot(),
    getMachineId(),
    assetLocalState(),
  ]);
  return NextResponse.json({ license: snapshot, machine, assets });
}
