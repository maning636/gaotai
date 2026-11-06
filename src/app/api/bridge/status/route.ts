import { NextResponse } from "next/server";
import { guard } from "../../../../lib/license/guard";
import { getBackendBridge } from "../../../../lib/bridge/backend-client";

export const runtime = "nodejs";

/**
 * WS 桥状态查询。
 *
 * 前端发布弹窗用它轮询「扩展是否已连接」。running 表示后端起过桥接客户端
 * 且连上了 Electron 主进程起的 WS 服务端；port 来自 GAOTAI_WS_PORT。
 */
export async function GET() {
  const blocked = await guard();
  if (blocked) return blocked;

  const bridge = getBackendBridge();
  const port = Number(process.env.GAOTAI_WS_PORT || 0);
  return NextResponse.json({
    running: bridge.isConnected(),
    port: port > 0 ? port : 0,
    clients: bridge.isConnected() ? 1 : 0,
  });
}
