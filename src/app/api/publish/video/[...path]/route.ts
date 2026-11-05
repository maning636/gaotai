import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { guard } from "../../../../../lib/license/guard";
import { readVideo } from "../../../../../lib/videos";

export const runtime = "nodejs";

/**
 * 读取本地视频库里的一段视频，返回二进制供 <video src> 使用。
 * 路径校验完全依赖 resolveVideo（拒绝绝对路径、.. 与反斜杠），并再次 stat 校验是文件。
 *
 * 视频体积大，客户端常做 Range 请求（拖进度条只拉一段）；
 * 这里把 Range 透传给 fs 并回 206，不支持的话浏览器只能整段下完才能拖动。
 */
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const blocked = await guard();
  if (blocked) return blocked;
  const { path } = await params;
  const result = await readVideo(path.join("/"));
  if (!result) {
    return NextResponse.json({ error: "视频不存在或路径非法" }, { status: 404 });
  }

  const stat = await fs.stat(result.abs);
  const range = request.headers.get("range");
  // 没有 Range 就整段返回；视频通常几十到几百兆，首次播放走这一条。
  if (!range) {
    const buf = await fs.readFile(result.abs);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": result.mime,
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  // 解析 bytes=start-end。start 缺失按 0，end 缺失按文件尾；任一非法就回 416。
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${stat.size}` },
    });
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${stat.size}` },
    });
  }
  // 只读请求的那一段：整段读进内存再切会白占几百兆。
  const chunk = Buffer.alloc(end - start + 1);
  const handle = await fs.open(result.abs, "r");
  try {
    await handle.read(chunk, 0, chunk.length, start);
  } finally {
    await handle.close();
  }
  return new NextResponse(chunk, {
    status: 206,
    headers: {
      "Content-Type": result.mime,
      "Content-Length": String(chunk.length),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
