import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { getBackendBridge } from "../../../../lib/bridge/backend-client";

export const runtime = "nodejs";

const querySchema = z.object({
  taskId: z.string().trim().min(1).max(80),
});

/**
 * 查询一次同步任务的状态。
 *
 * 前端在 POST /api/bridge/sync 拿到 taskId 后轮询这里，
 * 直到 status 变成 done / failed，再读 result 展示。
 */
export async function GET(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ taskId: url.searchParams.get("taskId") ?? "" });
  if (!parsed.success) {
    return NextResponse.json({ error: "缺少 taskId 参数" }, { status: 400 });
  }

  try {
    const bridge = getBackendBridge();
    const task = await bridge.getTask(parsed.data.taskId);
    return NextResponse.json({ taskId: task.taskId, status: task.status, result: task.result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "查询任务失败";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
