import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireAuth } from "../../../../lib/auth";
import { dataDir } from "../../../../lib/paths";

/**
 * 卡片 PNG 批量导出接口。
 *
 * 前端把每页截图（PNG dataURL）POST 过来，这里解码后写盘。
 * 目标目录：默认落在 `<数据目录>/card-export/`，也接受前端传入的相对子目录
 * （如用户选择的文件夹名）。文件名按序命名：card-01.png、card-02.png …
 *
 * 安全约束：
 * - 只接受 data:image/png;base64,... 的 dataURL（拒绝任意 base64）
 * - 目标目录必须是相对路径，禁绝对路径与 `..`，保证落在卡片导出根目录内
 * - 单页 PNG 上限 32MB（3:4 比例 2x 缩放不会超过）
 */

export const runtime = "nodejs";

const MAX_PNG_BYTES = 32 * 1024 * 1024;

/** 卡片导出根目录（可写数据目录下）。 */
function exportRoot(): string {
  return path.join(dataDir(), "card-export");
}

/** 解析目标子目录，任何越界返回 null。 */
function resolveSubDir(input: string): string | null {
  if (!input) return "";
  if (input.startsWith("/") || input.startsWith("\\")) return null;
  if (/[\\]/.test(input)) return null;
  if (/\0|\n|\r/.test(input)) return null;
  const segments = input.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return null;
  }
  return segments.join(path.sep);
}

/** 解析 dataURL，只认 png。返回 Buffer 或 null。 */
function decodePngDataUrl(dataUrl: string): Buffer | null {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return null;
  const base64 = dataUrl.slice(prefix.length);
  if (!base64 || base64.length % 4 !== 0) return null;
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length === 0 || buf.length > MAX_PNG_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * 接收一批 PNG dataURL 并写盘。
 *
 * 请求体：{ pages: string[]（dataURL）, dir?: string（相对子目录，可选） }
 * 返回：{ ok: true, files: string[]（相对路径） }
 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const pages = (body as { pages?: unknown }).pages;
  const dirInput = (body as { dir?: unknown }).dir;
  if (!Array.isArray(pages) || pages.length === 0) {
    return NextResponse.json({ error: "没有收到要导出的图片。" }, { status: 400 });
  }
  const subDir = resolveSubDir(typeof dirInput === "string" ? dirInput : "");
  if (subDir === null) {
    return NextResponse.json({ error: "导出目录不合法。" }, { status: 400 });
  }

  try {
    const root = exportRoot();
    const target = subDir ? path.join(root, subDir) : root;
    await fs.mkdir(target, { recursive: true });

    const written: string[] = [];
    // 起始序号：目录里已有文件就接在后面，避免覆盖。
    const existing = await fs.readdir(target).catch(() => [] as string[]);
    const maxSeq = existing.reduce((max, name) => {
      const match = /^card-(\d+)\.png$/.exec(name);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    let seq = maxSeq;

    for (const dataUrl of pages) {
      if (typeof dataUrl !== "string") continue;
      const buf = decodePngDataUrl(dataUrl);
      if (!buf) continue;
      seq += 1;
      const name = `card-${String(seq).padStart(2, "0")}.png`;
      await fs.writeFile(path.join(target, name), buf);
      written.push(subDir ? `${subDir}/${name}` : name);
    }

    if (written.length === 0) {
      return NextResponse.json({ error: "没有写入任何图片：PNG 数据无效。" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, files: written, dir: subDir || "" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "写盘失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
