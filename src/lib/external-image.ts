import { lookup } from "node:dns/promises";
import { storeImageBytes } from "./files";

/**
 * 外链图片的下载与收进本机素材库。
 *
 * **为什么需要这一步**：公众号**不接受外链图片**——正文里写 `![](https://…)`，
 * 推上去之后那张图会变成空白。所以外链图必须先落到本机，再走上传微信那条路。
 *
 * 导入已有文章时这条尤其要紧：用户从别的编辑器里带来的图，
 * 十有八九是外链的，不处理的话稿子推出去图全没了。
 */

/** 单张图的大小上限。10MB 足够一张封面级的图，再大就不像正文配图了。 */
const MAX_BYTES = 10 * 1024 * 1024;

/** 下载超时。 */
const TIMEOUT_MS = 20_000;

/**
 * 这个主机是不是内网地址？
 *
 * 这是**防 SSRF** 的关键闸门：稿台是本地软件，但用户会往里贴任意网址。
 * 不挡的话，粘贴 `![](http://169.254.169.254/latest/meta-data/)` 就能让软件
 * 去读内网——包括云上的密钥接口。
 */
export function isPrivateAddress(address: string): boolean {
  const host = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // IPv6 的唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 解析主机名，拿到它实际指向的 IP。解析失败返回 null。 */
async function resolveHost(hostname: string): Promise<string | null> {
  try {
    const info = await lookup(hostname, { all: true });
    return info.length ? info[0].address : null;
  } catch {
    return null;
  }
}

/**
 * 这个地址可以下载吗？
 *
 * 只允许 http(s)，且解析出来的 IP 不能落在内网里。
 */
export async function isDownloadableUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(hostname)) return false;
  const address = await resolveHost(hostname);
  if (!address) return false;
  return !isPrivateAddress(address);
}

/** 从 Markdown 里找出所有指向外网的图片地址。 */
export function extractExternalImageRefs(markdown: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // 只认 Markdown 图片语法 ![alt](url)——正文里的普通链接不是图。
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/g)) {
    const url = match[1];
    if (seen.has(url)) continue;
    seen.add(url);
    found.push(url);
  }
  return found;
}

/**
 * 下载一张外链图，存进本机素材库。
 *
 * 返回它在正文里该用的地址（`/api/files/img/xxx.png`）。
 * 失败时抛错，调用方负责如实报给用户。
 */
export async function downloadExternalImage(raw: string): Promise<string> {
  if (!(await isDownloadableUrl(raw))) {
    throw new Error("这个地址不让下载（不是 http(s)，或者指向内网）。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(raw, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new Error(`下载失败（HTTP ${response.status}）。`);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length && length > MAX_BYTES) {
      throw new Error("图太大了（超过 10MB）。");
    }
    const type = response.headers.get("content-type") ?? "";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      throw new Error("图太大了（超过 10MB）。");
    }
    // 扩展名按内容类型推断；实在认不出来就当 png。
    const ext = type.includes("jpeg") || type.includes("jpg")
      ? ".jpg"
      : type.includes("webp")
        ? ".webp"
        : ".png";
    const stored = await storeImageBytes(bytes, `imported${ext}`);
    return stored.url;
  } finally {
    clearTimeout(timer);
  }
}
