import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { videosDir } from "./paths";

/**
 * 本地视频文件服务层。
 *
 * 视频与图片是两种东西：体积大得多（几十到几百兆），格式也少（本地只认 MP4），
 * 所以单独一层而不是塞进 files.ts——那边的扩展名白名单、大小上限、MIME 表都是按图片写的。
 *
 * 与图片一致的安全约定（照搬 resolveImage 的判断顺序，一处都不能少）：
 * - 只接受相对路径，拒绝绝对路径、.. 段、反斜杠、控制字符
 * - 扩展名必须在白名单里
 * - 每次访问前 fs.stat 校验是普通文件
 * - path.relative 二次校验解析后的路径仍在视频根目录内
 *
 * URL 与磁盘路径一一对应：<数据根>/videos/foo.mp4 <-> /api/publish/video/foo.mp4
 * 前端只拿 url，磁盘绝对路径不出这一层。
 */

export const VIDEO_EXT = new Set([".mp4", ".mov", ".avi", ".mkv"]);

/** 单个视频的本地上限。微信永久视频素材 ≤200MB，本地存宽松一点留出压缩余量。 */
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export interface LocalVideo {
  path: string;
  size: number;
  mtime: string;
  url: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx).toLowerCase();
}

export function videoMime(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";
}

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.has(extOf(name));
}

export function videoDir(): string {
  return videosDir();
}

/**
 * 把视频库里的相对路径拼成可访问地址。
 *
 * 按段百分号编码：视频名常带中文与空格，不编码的话浏览器请求会带裸中文，
 * Next 路由解码后仍可能对不上（同 imageUrl 的处理）。
 */
export function videoUrl(relPath: string): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `/api/publish/video/${encoded}`;
}

/**
 * 把前端传入的相对路径解到磁盘，任何越界输入都返回 null。
 * 接受：foo.mp4 / subdir/foo.mp4 / a%2Ffoo.mp4（等价于 a/foo.mp4）
 * 拒绝：绝对路径、含 .. 或 . 段、含反斜杠、含控制字符、非受支持扩展名
 */
export async function resolveVideo(input: string): Promise<string | null> {
  if (!input || typeof input !== "string") return null;
  // 前端与 Next.js 已完成 URL 解码；这里不再二次 decode，避免 %2e%2e 之类绕过。
  const decoded = input;
  if (decoded.startsWith("/") || decoded.startsWith("\\")) return null;
  if (/[\\]/.test(decoded)) return null;
  if (/\0|\n|\r/.test(decoded)) return null;
  const segments = decoded.split("/");
  for (const seg of segments) {
    if (!seg) return null;
    if (seg === "." || seg === "..") return null;
  }
  if (!isVideoName(segments[segments.length - 1])) return null;
  const root = videoDir();
  const abs = path.resolve(root, ...segments);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || rel.includes(path.sep + "..")) return null;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && isVideoName(entry.name)) out.push(full);
  }
  return out;
}

export async function ensureVideoDir(): Promise<void> {
  await fs.mkdir(videoDir(), { recursive: true });
}

/**
 * 列出视频库里的所有视频，按修改时间倒序。
 *
 * 新传的排前面：上传区的典型动作是「刚传完就要用」，最新的在最上面少滚一下。
 */
export async function listVideos(): Promise<LocalVideo[]> {
  const root = videoDir();
  await ensureVideoDir();
  const files = await walk(root);
  const items: LocalVideo[] = [];
  for (const full of files) {
    const stat = await fs.stat(full);
    const rel = path.relative(root, full).split(path.sep).join("/");
    items.push({
      path: rel,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      url: videoUrl(rel),
    });
  }
  items.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.path.localeCompare(b.path)));
  return items;
}

export async function deleteVideo(input: string): Promise<void> {
  const abs = await resolveVideo(input);
  if (!abs) throw new Error("非法文件路径");
  await fs.unlink(abs);
}

/**
 * 把一份视频字节存进视频库，返回它自己的相对路径与访问地址。
 *
 * 文件名用内容摘要做前缀：同一段视频重复存不会留下多份垃圾，
 * 不同内容也不会互相覆盖。视频体积大，重复占盘的代价远高于图片。
 * 扩展名沿用原文件，但必须是受支持的视频类型。
 */
export async function storeVideoBytes(bytes: Buffer, originalName: string): Promise<LocalVideo> {
  if (!bytes.length) throw new Error("视频内容为空。");
  const ext = extOf(originalName);
  if (!VIDEO_EXT.has(ext)) {
    throw new Error("只支持 mp4 / mov / avi / mkv 格式的视频。");
  }
  await ensureVideoDir();
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}${ext}`;
  const abs = path.join(videoDir(), name);
  await fs.writeFile(abs, bytes);
  const stat = await fs.stat(abs);
  return {
    path: name,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    url: videoUrl(name),
  };
}

/**
 * 从上传的原始文件名里取一个能用的名字。
 *
 * 视频是外面来的（剪映导出、相机拍摄、别人发来的），原文件名往往就是有用的信息
 * （`2026-11-06_新品发布_横版.mp4`），换成内容哈希等于把这条线索抹了。
 * Windows 文件名有一堆非法字符且不能带目录，所以要清一遍——同 safeImageFileName。
 */
export function safeVideoFileName(originalName: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? "";
  const ext = extOf(base);
  const stem = base.slice(0, Math.max(0, base.length - ext.length));
  const cleaned = stem
    // 明确要挡掉 \u0000-\u001f：文件名来自外部工具，Windows 不接受控制字符。
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (!cleaned) return "";
  return `${cleaned.slice(0, 80)}${ext}`;
}

/**
 * 按**指定文件名**存一份视频。
 *
 * 上传区要保留可读名字（用户得在列表里认出哪个是哪条），内容摘要做前缀的存法不合适，
 * 所以单开一个入口。文件名只允许落在视频根目录内：不接受目录分隔符、绝对路径与 `..`。
 * 重名时自动加序号，绝不覆盖已有文件——视频覆盖了找不回来。
 */
export async function storeVideoAs(bytes: Buffer, fileName: string): Promise<LocalVideo> {
  if (!bytes.length) throw new Error("视频内容为空。");
  const name = fileName.trim();
  if (!name) throw new Error("文件名不能为空。");
  if (/[\\/]/.test(name)) throw new Error("文件名里不能带目录分隔符。");
  if (name === "." || name === ".." || name.includes("..")) throw new Error("文件名不合法。");
  // 明确要拒绝控制字符，不是手滑写进来的。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) throw new Error("文件名里有非法字符。");
  const ext = extOf(name);
  if (!VIDEO_EXT.has(ext)) {
    throw new Error("只支持 mp4 / mov / avi / mkv 格式的视频。");
  }
  await ensureVideoDir();
  const root = videoDir();
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  let finalName = name;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(root, finalName);
    try {
      await fs.access(candidate);
      finalName = `${stem}-${index}${ext}`;
    } catch {
      break;
    }
  }
  const abs = path.join(root, finalName);
  await fs.writeFile(abs, bytes);
  const stat = await fs.stat(abs);
  return {
    path: finalName,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    url: videoUrl(finalName),
  };
}

/** 读一个视频的绝对路径与 MIME，供文件访问路由用。 */
export async function readVideo(input: string): Promise<{ abs: string; mime: string } | null> {
  const abs = await resolveVideo(input);
  if (!abs) return null;
  return { abs, mime: videoMime(extOf(abs)) };
}
