import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { imagesDir } from "./paths";

/**
 * 本地素材文件服务层。所有图片都收敛到用户数据目录下的 images/ 下，避免误操作其它工程数据。
 * URL 与磁盘路径一一对应：<数据根>/images/foo/bar.png <-> /api/files/img/foo/bar.png
 *
 * 关键安全约定：
 * - 只接受相对路径，禁止绝对路径、.. 段、反斜杠、空段与非法字符
 * - 扩展名必须为 png/jpg/jpeg/webp 之一
 * - 每次访问前 fs.stat 校验是普通文件
 * - 使用 path.relative 二次校验解析后的路径仍在图片根目录内
 */

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface LocalImage {
  path: string;
  size: number;
  mtime: string;
  url: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx).toLowerCase();
}

export function imageMime(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";
}

export function isImageName(name: string): boolean {
  return IMAGE_EXT.has(extOf(name));
}

export function imageDir(): string {
  return imagesDir();
}

/**
 * 把素材库里的相对路径拼成可访问地址。
 *
 * 路径按段做百分号编码：生图产物用中文名（「2026-10-24_横版_公众号知乎_…」），
 * 不编码的话浏览器请求会带着裸中文，Next 路由解码后仍可能对不上。
 */
export function imageUrl(relPath: string): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `/api/files/img/${encoded}`;
}

/**
 * 把前端传入的相对路径解到磁盘，任何越界输入都返回 null。
 * 接受：foo.png / subdir/foo.png / a%2Ffoo.png（等价于 a/foo.png）
 * 拒绝：绝对路径、含 .. 或 . 段、含反斜杠、含控制字符、非受支持扩展名
 */
export async function resolveImage(input: string): Promise<string | null> {
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
  if (!isImageName(segments[segments.length - 1])) return null;
  const root = imageDir();
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
    else if (entry.isFile() && isImageName(entry.name)) out.push(full);
  }
  return out;
}

export async function ensureImageDir(): Promise<void> {
  await fs.mkdir(imageDir(), { recursive: true });
}

export async function listImages(): Promise<LocalImage[]> {
  const root = imageDir();
  await ensureImageDir();
  const files = await walk(root);
  const items: LocalImage[] = [];
  for (const full of files) {
    const stat = await fs.stat(full);
    const rel = path.relative(root, full).split(path.sep).join("/");
    items.push({
      path: rel,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      url: imageUrl(rel),
    });
  }
  items.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.path.localeCompare(b.path)));
  return items;
}

export async function deleteImage(input: string): Promise<void> {
  const abs = await resolveImage(input);
  if (!abs) throw new Error("非法文件路径");
  await fs.unlink(abs);
}

export async function readImage(input: string): Promise<{ abs: string; mime: string } | null> {
  const abs = await resolveImage(input);
  if (!abs) return null;
  return { abs, mime: imageMime(extOf(abs)) };
}

/**
 * 把一份图片字节存进素材库，返回它自己的相对路径与访问地址。
 *
 * 文件名用内容摘要做前缀：同一张图重复存不会留下多份垃圾，
 * 不同内容也不会互相覆盖。扩展名沿用原文件，但必须是受支持的图片类型。
 */
export async function storeImageBytes(bytes: Buffer, originalName: string): Promise<LocalImage> {
  if (!bytes.length) throw new Error("图片内容为空。");
  const ext = extOf(originalName);
  if (!IMAGE_EXT.has(ext)) {
    throw new Error("只支持 png / jpg / jpeg / webp 格式的图片。");
  }
  await ensureImageDir();
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}${ext}`;
  const abs = path.join(imageDir(), name);
  await fs.writeFile(abs, bytes);
  const stat = await fs.stat(abs);
  return {
    path: name,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    url: imageUrl(name),
  };
}

/**
 * 从上传的原始文件名里取一个能用的名字。
 *
 * 图是外面来的（别的工具生图、截图、照片），**原文件名往往就是有用的信息**
 * （`2026-10-24_横版_公众号知乎_承受得起_2000x1116.jpg`），
 * 换成内容哈希等于把这条线索抹了。
 *
 * 但 Windows 的文件名有一堆非法字符，而且不能带目录，所以要清一遍。
 */
export function safeImageFileName(originalName: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? "";
  const ext = extOf(base);
  const stem = base.slice(0, Math.max(0, base.length - ext.length));
  // eslint-disable-next-line no-control-regex
  const cleaned = stem
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (!cleaned) return "";
  return `${cleaned.slice(0, 80)}${ext}`;
}

/**
 * 按**指定文件名**存一份图片。
 *
 * 生图产物要保留可读名字（原图 / 副本各自带真实像素尺寸），
 * 内容摘要做前缀的存法在这里不合适，所以单开一个入口。
 *
 * 文件名只允许落在图片根目录内：不接受目录分隔符、绝对路径与 `..`。
 * 重名时自动加序号，绝不覆盖已有文件。
 */
export async function storeImageAs(bytes: Buffer, fileName: string): Promise<LocalImage> {
  if (!bytes.length) throw new Error("图片内容为空。");
  const name = fileName.trim();
  if (!name) throw new Error("文件名不能为空。");
  if (/[\\/]/.test(name)) throw new Error("文件名里不能带目录分隔符。");
  if (name === "." || name === ".." || name.includes("..")) throw new Error("文件名不合法。");
  if (/[\u0000-\u001f]/.test(name)) throw new Error("文件名里有非法字符。");
  const ext = extOf(name);
  if (!IMAGE_EXT.has(ext)) {
    throw new Error("只支持 png / jpg / jpeg / webp 格式的图片。");
  }
  await ensureImageDir();
  const root = imageDir();
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
    url: imageUrl(finalName),
  };
}
