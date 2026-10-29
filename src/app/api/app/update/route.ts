import { NextResponse } from "next/server";
import { checkForUpdate, CURRENT_VERSION } from "@/lib/app-update";

export const runtime = "nodejs";

/**
 * 版本更新检查接口。
 *
 * 这个接口**刻意不加 requireAuth / guard**：阻塞页在用户登录之前就要能显示
 * （未激活授权也要能提示「去更新」），加了登录守卫反而让锁页逻辑失效。
 *
 * 极宽松限流：同进程每 5 秒最多放 1 次真实网络请求，其余全部走 `checkForUpdate`
 * 的内存缓存。页面在挂载时、以及「我已更新，重新检查」按钮点击时都可能触发，
 * 不限制的话用户反复刷新页面会反复打授权服务器。
 *
 * 响应：
 *   GET /api/app/update            → { policy: <AppPolicy|null>, currentVersion }
 *   GET /api/app/update?force=1    → 强制绕过缓存重新问服务端
 *
 * `policy` 为 null 表示「检查失败/无可执行策略」，前端据此不拦。
 */

/** 真实网络请求的最小间隔：5 秒。 */
const MIN_NETWORK_INTERVAL_MS = 5000;

let lastNetworkAt = 0;

/** 是否离上一次真实网络请求已超过最小间隔。 */
function canDoNetworkRequest(force: boolean): boolean {
  const now = Date.now();
  if (force || now - lastNetworkAt >= MIN_NETWORK_INTERVAL_MS) {
    lastNetworkAt = now;
    return true;
  }
  return false;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  // 限流：5 秒内的重复请求直接走缓存（或返回 null），不打网络。
  // force 也会被限流兜住，避免「重新检查」按钮被连点打爆服务端。
  const policy = await checkForUpdate({
    force,
    allowNetwork: canDoNetworkRequest(force),
  });

  return NextResponse.json({ policy, currentVersion: CURRENT_VERSION });
}
