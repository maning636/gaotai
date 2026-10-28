import path from "node:path";
import { NextResponse } from "next/server";
import { guard } from "../../../../lib/license/guard";
import { imageDir, storeImageBytes } from "../../../../lib/files";
import { clearCover, getCoverState, setCoverFromFile, setCoverFromLibrary } from "../../../../lib/wechat-cover";

export const runtime = "nodejs";
export const maxDuration = 120;

/** 封面图大小上限。微信图片素材单张不超过 10MB。 */
const MAX_COVER_BYTES = 10 * 1024 * 1024;

/**
 * 公众号封面的当前状态。
 *
 * mediaId 是微信永久素材的 id，推草稿时直接用；mediaId 本身也是凭据的一部分，
 * 所以不返回，只返回「有没有配好」和本机那张封面长什么样。
 */
export async function GET() {
  const blocked = await guard();
  if (blocked) return blocked;
  const state = getCoverState();
  return NextResponse.json({
    configured: state.configured,
    image: state.image,
    previewUrl: state.previewUrl,
  });
}

/**
 * 设置封面。
 *
 * 两种入参：
 * - multipart：直接传文件，稿台会把它存进本机素材库再上传微信；
 * - JSON { path }：用素材库里已经有的图。
 *
 * 两条路最终都会往微信永久素材库传一次，拿到 thumb_media_id 存进 .env。
 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "没有收到图片文件。" }, { status: 400 });
      }
      if (!file.size) {
        return NextResponse.json({ error: "图片内容为空。" }, { status: 400 });
      }
      if (file.size > MAX_COVER_BYTES) {
        return NextResponse.json({ error: "封面图不能超过 10MB。" }, { status: 400 });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const stored = await storeImageBytes(bytes, file.name || "cover.png");
      const absolute = path.join(imageDir(), stored.path);
      const state = await setCoverFromFile(absolute, stored.path);
      return NextResponse.json({
        ok: true,
        configured: state.configured,
        image: state.image,
        previewUrl: state.previewUrl,
      });
    }

    const body = (await request.json()) as { path?: unknown };
    const relPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!relPath) {
      return NextResponse.json({ error: "请选择一张图片。" }, { status: 400 });
    }
    const state = await setCoverFromLibrary(relPath);
    return NextResponse.json({
      ok: true,
      configured: state.configured,
      image: state.image,
      previewUrl: state.previewUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "设置封面失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** 清空封面。 */
export async function DELETE() {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const state = await clearCover();
    return NextResponse.json({ ok: true, configured: state.configured });
  } catch (error) {
    const message = error instanceof Error ? error.message : "清空封面失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
