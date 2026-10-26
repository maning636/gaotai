import { resolveImage } from "./files";
import { downloadExternalImage, extractExternalImageRefs } from "./external-image";
import { uploadInlineImage } from "./wechat";
import type { WechatCredentials } from "./wechat-config";

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
 */

/** 本机素材库在正文里的地址前缀。 */
export const LOCAL_IMAGE_PREFIX = "/api/files/img/";

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
  /** 成功换掉的图片数。 */
  uploaded: number;
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
 * 单张失败不打断整篇——图片挂掉不该让整篇稿子推不上去。失败项会被如实报回去，
 * 由界面提示用户「有 N 张图在公众号里会显示不出来」，而不是悄悄吞掉。
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
  if (!refs.length) return { markdown: working, uploaded: 0, failed };

  const replacements = new Map<string, string>();

  for (const ref of refs) {
    const name = localImageName(ref);
    const absolute = await resolveImage(name);
    if (!absolute) {
      failed.push({ ref, reason: "本机素材库里找不到这张图。" });
      continue;
    }
    try {
      const asset = await uploadInlineImage(absolute, creds);
      replacements.set(ref, asset.url);
    } catch (error) {
      failed.push({ ref, reason: error instanceof Error ? error.message : "上传失败" });
    }
  }

  return {
    markdown: replaceImageRefs(working, replacements),
    uploaded: replacements.size,
    failed,
  };
}
