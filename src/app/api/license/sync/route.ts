import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { ensureAssets } from "../../../../lib/assets/sync";
import { getLicenseState } from "../../../../lib/license/gate";

export const runtime = "nodejs";

/**
 * POST /api/license/sync
 *
 * 手动触发一次资产同步（激活后从授权服务器加密下发四类只读资产）。
 * 未激活返回 403。结果只带一行状态与版本/错误，失败不抛 500——
 * 资源包同步失败不该被当成接口故障。
 */
export async function POST() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const state = await getLicenseState();
  if (state.status !== "activated") {
    return NextResponse.json(
      { error: "尚未激活授权，无法同步资源包。", code: "not_activated", message: "尚未激活授权，无法同步资源包。" },
      { status: 403 },
    );
  }

  const result = await ensureAssets({ force: true });
  if (result.status === "failed") {
    return NextResponse.json({ assets: { status: "failed", error: result.error } });
  }
  return NextResponse.json({
    assets: { status: result.status, version: result.status === "skipped" ? undefined : result.version },
  });
}
