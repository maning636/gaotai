import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
import { refresh } from "../../../../lib/license/client";
import { getMachineId } from "../../../../lib/license/machine";
import { readTokenCache, writeTokenCache } from "../../../../lib/license/store";
import { licenseSnapshot, resetLicenseCache } from "../../../../lib/license/gate";
import { httpStatusFor } from "../../../../lib/license/types";

export const runtime = "nodejs";

/**
 * POST /api/license/refresh
 *
 * 用缓存里的 code + 本机 machine 调服务端刷新。
 * 成功则写缓存并刷新 gate 缓存，返回 `{ license, machine }`。
 * 失败返回 `{ error, code, message }`，HTTP 状态按契约错误码映射。
 * 错误响应里不回显 token。
 *
 * 如果本地没有缓存（没激活过），直接返回 `not_activated`——
 * 刷新的前提是已经激活过。
 */
export async function POST() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const cache = await readTokenCache();
  if (!cache) {
    return NextResponse.json(
      {
        error: "not_activated",
        code: "not_activated",
        message: "尚未激活授权，无法刷新。请先输入注册码激活。",
      },
      { status: 403 },
    );
  }

  const machine = await getMachineId();
  const result = await refresh({ code: cache.code, machine });

  if (!result.ok) {
    const status = httpStatusFor(result.error.code);
    return NextResponse.json(
      { error: result.error.code, code: result.error.code, message: result.error.message },
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

  const snapshot = await licenseSnapshot();
  return NextResponse.json({ license: snapshot, machine });
}
