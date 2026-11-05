import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { videosDir } from "../../../../lib/paths";
import { listVideos, storeVideoAs, safeVideoFileName, deleteVideo, MAX_VIDEO_BYTES } from "../../../../lib/videos";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 视频库列表与上传。
 *
 * 视频文件比图片大得多（几十到几百兆），在 Electron 本地走 multipart 直传，
 * 不走云端中转——桌面版的磁盘就是最近的存储。
 */

/** 列出本地视频库。 */
export async function GET() {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    return NextResponse.json(await listVideos());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取视频列表失败" },
      { status: 500 },
    );
  }
}

const MAX = MAX_VIDEO_BYTES;

/** 上传一个视频到本地视频库。 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "请用 multipart/form-data 上传视频。" }, { status: 400 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "没有收到视频文件。" }, { status: 400 });
    }
    if (!file.size) {
      return NextResponse.json({ error: "视频内容为空。" }, { status: 400 });
    }
    if (file.size > MAX) {
      return NextResponse.json({ error: `视频不能超过 ${MAX / 1024 / 1024}MB。` }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const name = safeVideoFileName(file.name || "");
    if (!name) {
      return NextResponse.json({ error: "这个文件名用不了，换个名字再传。" }, { status: 400 });
    }
    const stored = await storeVideoAs(bytes, name);
    return NextResponse.json({ ok: true, video: stored }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "上传视频失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

const deleteSchema = z.object({ path: z.string().trim().min(1) });

/** 删除一个视频。 */
export async function DELETE(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const body = await request.json();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "缺少 path。" }, { status: 400 });
    }
    await deleteVideo(parsed.data.path);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除视频失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// videosDir 导出给需要磁盘路径的地方（比如视频文件路由），这里 re-export 保持入口统一。
export { videosDir, path };
