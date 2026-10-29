import { requireAuth } from "../auth";
import { requireLicense } from "./gate";
import { checkForUpdate } from "../app-update";

/**
 * 登录 + 授权的合并守卫。
 *
 * 写法与 `requireAuth` 一致：全部通过时返回 null，否则返回需要直接返回给客户端的 Response。
 * 先查登录（401），再查授权（403 not_activated），保证未登录时不泄露授权状态。
 *
 * 最后加一步「版本检查」：授权已通过但被服务端判定必须更新（`blocked`）时，
 * 返回 426 `update_required`。检查失败（`checkForUpdate` 返回 null）放行——
 * 更新检查永远不能把接口锁死，网络不通时应用照常使用。
 */
export async function guard(): Promise<Response | null> {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  const noLicense = await requireLicense();
  if (noLicense) return noLicense;

  const policy = await checkForUpdate();
  if (policy?.blocked === true) {
    return Response.json(
      {
        error: `需要更新到 v${policy.latest} 才能继续使用`,
        code: "update_required",
        latest: policy.latest,
      },
      { status: 426 },
    );
  }
  return null;
}
