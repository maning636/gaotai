import { resolveImage } from "./files";
import { downloadExternalImage, extractExternalImageRefs } from "./external-image";
import { uploadInlineImage, WechatError } from "./wechat";
import type { WechatCredentials } from "./wechat-config";
import { fingerprintFile, getCachedUrl, setCachedUrl } from "./wechat/image-cache";

/**
 * 正文图片的 CDN 化。
 *
 * 稿台把配图和正文图片都存在本机的素材库里，正文里写的是 /api/files/img/xxx.png
 * 这种本机地址。公众号服务器根本访问不到本机，所以推草稿之前必须逐张换成
 * 微信自己的图片地址——否则稿子推上去了，图全是空的。
 *
 * **外链图也要处理**：公众号不接受外链图片，导入的现成文章里十有八九带外链图。
 * 所以先把外链图下载到本机素材库，再走同一条上传微信的路。
 *
 * 这里刻意把「找出地址」「换地址」拆成两个纯函数加一个联网步骤：
 * 纯函数能被测试覆盖，联网那步只负责把地址变成微信地址。
 *
 * 上传这步要**并发**：一篇稿子十几张图，一张张串行传太慢。按 3 路并发分批，
 * 不引第三方并发库，Promise.all 就够。
 *
 * 图上传微信有频率限制（45009），一旦撞上就**熔断**：剩下的图都不传了，
 * 整篇稿子也别推——不然推上去一堆图是空的。非致命的失败（网络抖动、单张损坏）
 * 不打断整篇，用黄色占位图顶替，失败项如实报回，由界面提示用户。
 */

/** 本机素材库在正文里的地址前缀。 */
export const LOCAL_IMAGE_PREFIX = "/api/files/img/";

/** 并发上传的路数。 */
export const UPLOAD_CONCURRENCY = 3;

/**
 * 上传失败的占位图：1x1 黄色 PNG（data URL）。
 *
 * 公众号正文里图片地址必须可达，非致命失败时不能用原样本机地址顶——
 * 那会变成空图；也不能不替换——那会让整篇推不上去。用一张黄图占位，
 * 至少版式不塌，用户也一眼能看到「这里有张图没传上去」。
 */
export const YELLOW_PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4/5/hPwAH/QL+ppTFtAAAAABJRU5ErkJggg==";

/**
 * 从正文地址里取出素材库里的相对路径。
 *
 * 正文里的地址是**百分号编码**过的（生图产物的文件名带中文，
 * 比如 `2026-10-24_横版_公众号知乎_…jpg` → `%E6%A8%AA…`），
 * 而磁盘上的文件名是解码后的。直接拿编码串去找文件会**找不到**——
 * 图不会上传微信，推出去的稿子里那图是空的。
 */
export function localImageName(ref: string): string {
  const raw = ref.slice(LOCAL_IMAGE_PREFIX.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    // 地址里有裸 % 之类的不合法编码，就按原样试一次。
    return raw;
  }
}

/**
 * 找出正文里所有指向本机素材库的图片地址。
 *
 * 保持出现顺序并去重——同一张图在正文里引用两次只上传一次。
 */
export function extractLocalImageRefs(markdown: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(`${LOCAL_IMAGE_PREFIX}[^)\\s"'<>]+`, "g");
  for (const hit of markdown.matchAll(pattern)) {
    const ref = hit[0];
    if (seen.has(ref)) continue;
    seen.add(ref);
    found.push(ref);
  }
  return found;
}

/**
 * 把正文里的本机图片地址换成新地址。
 *
 * 纯函数：只做字符串替换，不碰网络。
 */
export function replaceImageRefs(markdown: string, replacements: Map<string, string>): string {
  let output = markdown;
  for (const [from, to] of replacements) {
    output = output.split(from).join(to);
  }
  return output;
}

export type ImageUploadFailure = {
  /** 正文里的原始地址。 */
  ref: string;
  /** 失败原因，直接可以显示给用户。 */
  reason: string;
};

export type ImageUploadReport = {
  /** 换好地址之后的正文。 */
  markdown: string;
  /** 本次真正上传到微信的图片数（不含缓存命中）。 */
  uploaded: number;
  /** 命中了指纹缓存、直接复用上次地址的图片数。 */
  cached: number;
  /** 没换成的图片，附原因。 */
  failed: ImageUploadFailure[];
};

/**
 * 把正文里的图片逐张上传到微信，换成公众号能访问的地址。
 *
 * 两类地址都要处理：
 * - **本机地址**（/api/files/img/xxx.png）：直接找到文件上传。
 * - **外链地址**（https://…）：先下载到本机素材库，再上传。
 *   公众号会过滤外链图，不处理的话稿子推出去图全没了。
 *
 * 三个提速与兜底手段：
 * - **并发**：一批最多 3 张同时传。
 * - **指纹缓存**：图片内容没变，直接复用上次换到的微信地址，一个请求都不发。
 * - **熔断**：撞上 45009（调用太频繁）就停，抛 WechatError，剩下的图不传了。
 *
 * 单张非致命失败不打断整篇——图片挂掉不该让整篇稿子推不上去。失败项会被
 * 如实报回去，由界面提示用户「有 N 张图在公众号里会显示不出来」，而不是悄悄吞掉。
 */
export async function cdnizeLocalImages(
  markdown: string,
  creds?: WechatCredentials,
): Promise<ImageUploadReport> {
  // 外链图先收进本机：下载完之后它就和本机图走同一条路。
  let working = markdown;
  const failed: ImageUploadFailure[] = [];
  const externalRefs = extractExternalImageRefs(markdown);
  for (const url of externalRefs) {
    try {
      const localUrl = await downloadExternalImage(url);
      working = working.split(url).join(localUrl);
    } catch (error) {
      failed.push({ ref: url, reason: error instanceof Error ? error.message : "下载失败" });
    }
  }

  const refs = extractLocalImageRefs(working);
  if (!refs.length) return { markdown: working, uploaded: 0, cached: 0, failed };

  const replacements = new Map<string, string>();
  let uploaded = 0;
  let cached = 0;

  // 熔断标记：45009 一出现，后续批次就不再发出，整篇作罢。
  let fatal: WechatError | null = null;

  /** 处理一张图：找文件 → 算指纹 → 查缓存 → 必要时上传。 */
  async function resolveOne(ref: string): Promise<void> {
    const name = localImageName(ref);
    const absolute = await resolveImage(name);
    if (!absolute) {
      failed.push({ ref, reason: "本机素材库里找不到这张图。" });
      return;
    }

    // 指纹是内容摘要：同一张图换个文件名也命中；同名文件换内容则自然重新上传。
    const fingerprint = await fingerprintFile(absolute);
    if (fingerprint) {
      const cachedUrl = getCachedUrl(fingerprint);
      if (cachedUrl) {
        replacements.set(ref, cachedUrl);
        cached += 1;
        return;
      }
    }

    try {
      const asset = await uploadInlineImage(absolute, creds);
      if (fingerprint) setCachedUrl(fingerprint, asset.url);
      replacements.set(ref, asset.url);
      uploaded += 1;
    } catch (error) {
      // 致命：调用太频繁。熔断停止，剩下的图一个都不再发。
      if (error instanceof WechatError && error.errcode === 45009) {
        fatal = error;
        return;
      }
      // 非致命：黄图占位，继续处理其它图。
      failed.push({ ref, reason: error instanceof Error ? error.message : "上传失败" });
      replacements.set(ref, YELLOW_PLACEHOLDER_IMAGE);
    }
  }

  // 并发分批：每批 3 张，熔断后不再发下一批。
  for (let index = 0; index < refs.length; index += UPLOAD_CONCURRENCY) {
    if (fatal) break;
    const batch = refs.slice(index, index + UPLOAD_CONCURRENCY);
    await Promise.all(batch.map(ref => resolveOne(ref).catch(() => {})));
  }
  if (fatal) throw fatal;

  return {
    markdown: replaceImageRefs(working, replacements),
    uploaded,
    cached,
    failed,
  };
}
