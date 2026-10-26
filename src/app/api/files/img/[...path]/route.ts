import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { requireAuth } from "../../../../../lib/auth";
import { readImage } from "../../../../../lib/files";

export const runtime = "nodejs";

/**
 * 读取 .tmp/images/ 下的一张照片，返回二进制供 <img src> 使用。
 * 路径校验完全依赖 resolveImage（拒绝绝对路径、.. 与反斜杠），并再次 stat 校验是文件。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  const { path } = await params;
  const result = await readImage(path.join("/"));
  if (!result) {
    return NextResponse.json({ error: "素材不存在或路径非法" }, { status: 404 });
  }
  const buf = await fs.readFile(result.abs);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": result.mime,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
