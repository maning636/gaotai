import path from "node:path";
import { imageUrl, resolveImage } from "./files";
import { readWechatCover, saveWechatCover } from "./wechat-config";
import { uploadPermanentImage } from "./wechat";

/**
 * 封面图。
 *
 * 公众号草稿必须带封面，参数是 thumb_media_id——它只能是**永久素材**的 media_id，
 * 不是图片地址，也不是临时素材。所以封面图必须单独往素材库里传一次，
 * 传完把 media_id 存进 .env，推草稿时直接用。
 *
 * 素材库的永久图片有每日新增上限，所以 media_id 存下来复用，不每次推送都重传。
 */

export type CoverState = {
  /** 是否已经配好封面。 */
  configured: boolean;
  /** 微信永久素材 media_id。 */
  mediaId: string;
  /** 本机素材库里的相对路径。 */
  image: string;
  /** 界面回显用：本机可访问的图片地址。 */
  previewUrl: string;
};

/** 读当前封面状态。 */
export function getCoverState(): CoverState {
  const cover = readWechatCover();
  return {
    configured: Boolean(cover.mediaId),
    mediaId: cover.mediaId,
    image: cover.image,
    // 文件名可能带中文（生图产物），地址要按段编码。
    previewUrl: cover.image ? imageUrl(cover.image) : "",
  };
}

/**
 * 把素材库里的一张图设为封面。
 *
 * relPath 是素材库里的相对路径（不含 /api/files/img/ 前缀）。
 */
export async function setCoverFromLibrary(relPath: string): Promise<CoverState> {
  const absolute = await resolveImage(relPath);
  if (!absolute) throw new Error("素材库里找不到这张图。");
  const asset = await uploadPermanentImage(absolute);
  await saveWechatCover({ mediaId: asset.mediaId, image: relPath });
  return getCoverState();
}

/**
 * 把本机刚上传的一张图设为封面。
 *
 * absolute 是磁盘上的绝对路径，relPath 是它在素材库里的相对路径（用于回显）。
 */
export async function setCoverFromFile(absolute: string, relPath: string): Promise<CoverState> {
  const asset = await uploadPermanentImage(absolute);
  await saveWechatCover({ mediaId: asset.mediaId, image: relPath });
  return getCoverState();
}

/** 清空封面配置。 */
export async function clearCover(): Promise<CoverState> {
  await saveWechatCover({ mediaId: "", image: "" });
  return getCoverState();
}

/** 素材库里某个相对路径对应的磁盘绝对路径，路径非法时返回 null。 */
export async function coverSourcePath(relPath: string): Promise<string | null> {
  const absolute = await resolveImage(relPath);
  return absolute ? path.normalize(absolute) : null;
}
