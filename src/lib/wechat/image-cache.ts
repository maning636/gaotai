import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getDb } from "../db";

/**
 * 正文图片的指纹缓存。
 *
 * 推草稿时正文里的图要逐张上传微信。同一张图在多次推送之间内容不变，
 * 却每次都要重新上传一遍——既慢，还白白消耗微信的接口调用频率。
 *
 * 这里用图片**内容**的 SHA-256 做指纹：内容没变，就直接复用上次换到的
 * 微信地址，一个请求都不发；只有内容变了（用户替换过图、重新生成过）
 * 才真的去上传一次。
 *
 * 指纹记的是内容摘要而不是文件路径，所以「同一张图换个文件名」也命中缓存；
 * 反过来「同名文件换内容」会得到新指纹、自然重新上传——两件事都不会搞错。
 *
 * 存储落在 SQLite 的 wechat_image_cache 表：本机数据库、无网络依赖，
 * 进程重启后缓存仍在。表结构见 db.ts 的 SCHEMA。
 */

export const IMAGE_CACHE_TABLE = "wechat_image_cache";

/** 图片内容 → 十六进制 SHA-256 指纹。 */
export function imageFingerprint(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 从磁盘读一张图并算指纹。读不到返回 null（调用方按「未命中」处理）。 */
export async function fingerprintFile(absolutePath: string): Promise<string | null> {
  try {
    const bytes = await readFile(absolutePath);
    if (!bytes.length) return null;
    return imageFingerprint(bytes);
  } catch {
    return null;
  }
}

/** 按指纹查缓存里的微信地址；没有就返回 null。 */
export function getCachedUrl(fingerprint: string): string | null {
  if (!fingerprint) return null;
  const row = getDb()
    .prepare(`SELECT wechat_url FROM ${IMAGE_CACHE_TABLE} WHERE fingerprint = ?`)
    .get(fingerprint) as { wechat_url: string } | undefined;
  return row?.wechat_url ?? null;
}

/** 记录一条指纹 → 微信地址。已存在就覆盖（内容没变地址也不会变）。 */
export function setCachedUrl(fingerprint: string, url: string): void {
  if (!fingerprint || !url) return;
  getDb()
    .prepare(
      `INSERT INTO ${IMAGE_CACHE_TABLE} (fingerprint, wechat_url, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET wechat_url = excluded.wechat_url`,
    )
    .run(fingerprint, url, Date.now());
}

/** 清空图片指纹缓存（测试隔离用：让每条用例从空缓存开始）。 */
export function clearImageCache(): void {
  getDb().prepare(`DELETE FROM ${IMAGE_CACHE_TABLE}`).run();
}
