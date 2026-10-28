import { requireAuth } from "../auth";
import { requireLicense } from "./gate";

/**
 * 登录 + 授权的合并守卫。
 *
 * 写法与 `requireAuth` 一致：全部通过时返回 null，否则返回需要直接返回给客户端的 Response。
 * 先查登录（401），再查授权（403 not_activated），保证未登录时不泄露授权状态。
 */
export async function guard(): Promise<Response | null> {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  return requireLicense();
}
