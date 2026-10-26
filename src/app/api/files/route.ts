import { NextResponse } from "next/server";
import { requireAuth } from "../../../lib/auth";
import { deleteImage, listImages, safeImageFileName, storeImageAs } from "../../../lib/files";

export const runtime = "nodejs";

/** 单张图片的上限。微信正文插图 1MB 以内最稳，封面素材 10MB。 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 列出素材库里的所有图片，供文件管理页面渲染。
 * 首次访问自动创建目录，空目录返回空数组。
 */
export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await listImages());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取素材列表失败" },
      { status: 500 },
    );
  }
}

/**
 * 传一张图进素材库。
 *
 * 图是**从外面来的**——别的工具生的图、自己截的图、拍的照片。
 * 稿台不生图，只负责把图收进来，让正文能引用它。
 *
 * 正文里写的是 `/api/files/img/xxx.png` 这种本机地址，推草稿时稿台会逐张
 * 换成微信自己的地址；公众号不接受外链图，所以图必须先落到本机。
 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "请用 multipart/form-data 上传图片。" }, { status: 400 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "没有收到图片文件。" }, { status: 400 });
    }
    if (!file.size) {
      return NextResponse.json({ error: "图片内容为空。" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "图片不能超过 10MB。" }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    // 保留原文件名：外部生图的图名往往带着日期、朝向、平台，是有用的信息。
    const name = safeImageFileName(file.name || "");
    if (!name) {
      return NextResponse.json({ error: "这个文件名用不了，换个名字再传。" }, { status: 400 });
    }
    const stored = await storeImageAs(bytes, name);
    return NextResponse.json({ ok: true, image: stored }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "上传素材失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * 删除单个素材，请求体必须是 { path: "相对路径" }，严格限制在 .tmp/images/ 之内。
 * 拒绝绝对路径、.. 与反斜杠，避免路径穿越。
 */
export async function DELETE(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json();
    const value = body && typeof body === "object" && typeof (body as { path?: unknown }).path === "string"
      ? (body as { path: string }).path
      : "";
    if (!value) throw new Error("缺少 path");
    await deleteImage(value);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除素材失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
