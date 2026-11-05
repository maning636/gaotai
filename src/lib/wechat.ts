import { readFile, stat as statFile } from "node:fs/promises";
import path from "node:path";
import { readWechatCredentials, type WechatCredentials } from "./wechat-config";

/**
 * 微信公众号 API 客户端。
 *
 * 只封装本产品真正用到的几个接口：
 * - 取 access_token
 * - 上传封面（永久素材，拿到草稿要的 thumb_media_id）
 * - 上传正文插图（图文消息图片接口，只换地址不占素材库配额）
 * - 推送到草稿箱（用户自己预览、自己发布）
 * - 拉已发布文章、做图文数据统计
 *
 * 全用 fetch，不引 SDK：接口就这几个，SDK 带来的抽象和体积都不划算。
 */

/**
 * 微信接口基址。
 *
 * 默认是官方地址；留这个口子是为了能对着本地假服务器把整条链路跑通——
 * 上传、换地址、带封面推草稿这几步，光靠单元测试验不到「拼在一起对不对」。
 */
const API_BASE = (process.env.GAOTAI_WECHAT_API_BASE?.trim() || "https://api.weixin.qq.com").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 30_000;

export class WechatError extends Error {
  /** HTTP 状态码。 */
  status?: number;
  /** 微信业务错误码。 */
  errcode?: number;
  /** 微信业务错误描述。 */
  errmsg?: string;

  constructor(message: string, options?: { status?: number; errcode?: number; errmsg?: string }) {
    super(message);
    this.name = "WechatError";
    this.status = options?.status;
    this.errcode = options?.errcode;
    this.errmsg = options?.errmsg;
  }
}

export type PublishedArticle = {
  articleId: string;
  title: string;
  author: string;
  digest: string;
  url: string;
  updateTime: number;
  content?: string;
};

export type ArticleStat = {
  articleId: string;
  title: string;
  readCount: number;
  likeCount: number;
  shareCount: number;
  commentCount: number;
  publishDate?: string;
};

export type WechatImageAsset = {
  mediaId: string;
  url: string;
  localPath: string;
};

type TokenEntry = { token: string; expiresAt: number };

const tokenCache = new Map<string, TokenEntry>();

function resolveCredentials(creds?: WechatCredentials): WechatCredentials {
  const resolved = creds ?? readWechatCredentials();
  if (!resolved.appId || !resolved.appSecret) {
    throw new WechatError("尚未配置公众号 AppID / AppSecret，请到「公众号」页面填写。");
  }
  return resolved;
}

/** 错误信息里不能出现 access_token——它是凭据的一部分。 */
function maskToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("***");
}

async function fetchWithTimeout(url: string, init: RequestInit, token?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new WechatError("微信接口请求超时（30 秒）。");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WechatError(`微信接口请求失败：${message}`);
  } finally {
    clearTimeout(timer);
    void token;
  }
}

/** 解析微信的标准响应：带 errcode 的业务错误一律抛 WechatError。 */
function parseWechatBody(text: string, token: string): Record<string, unknown> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new WechatError("微信接口返回的不是合法 JSON。", { errmsg: maskToken(text.slice(0, 300), token) });
  }
  const errcode = typeof body.errcode === "number" ? body.errcode : undefined;
  if (typeof errcode === "number" && errcode !== 0) {
    const errmsg = typeof body.errmsg === "string" ? body.errmsg : "未知错误";
    throw new WechatError(`微信接口报错 ${errcode}：${errmsg}`, { errcode, errmsg });
  }
  return body;
}

/**
 * 取 access_token。
 *
 * 微信的 token 有效期是 7200 秒，且**同一账号重复取会互相顶掉**（旧 token 立即失效），
 * 所以必须缓存，并提前 5 分钟过期。
 */
export async function getAccessToken(creds?: WechatCredentials): Promise<string> {
  const { appId, appSecret } = resolveCredentials(creds);
  const cached = tokenCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const url = `${API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;
  const response = await fetchWithTimeout(url, { method: "GET" });
  const text = await response.text();
  if (!response.ok) {
    throw new WechatError(`微信接口返回 HTTP ${response.status}`, {
      status: response.status,
      errmsg: maskToken(text.slice(0, 300), appSecret),
    });
  }
  const body = parseWechatBody(text, appSecret);
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (!token) throw new WechatError("微信接口没有返回 access_token。");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 7200;
  tokenCache.set(appId, { token, expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000 });
  return token;
}

/** 清空 token 缓存（凭据变更时用）。 */
export function clearAccessTokenCache(): void {
  tokenCache.clear();
}

/**
 * 上传一张本地图片到微信永久素材库。
 *
 * 永久素材会占用素材库配额（图片类每天新增数量有限），所以只用在**封面**上——
 * 草稿的 thumb_media_id 必须是永久素材的 media_id，正文插图不用它。
 */
export async function uploadPermanentImage(
  localPath: string,
  creds?: WechatCredentials,
): Promise<WechatImageAsset> {
  const token = await getAccessToken(creds);
  const absolute = path.resolve(localPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    throw new WechatError(`无法读取图片：${path.basename(absolute)}`);
  }
  if (!bytes.length) throw new WechatError("图片内容为空。");

  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(bytes)]), path.basename(absolute));

  const url = `${API_BASE}/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`;
  const response = await fetchWithTimeout(url, { method: "POST", body: form }, token);
  const text = await response.text();
  if (!response.ok) {
    throw new WechatError(`上传图片失败：HTTP ${response.status}`, {
      status: response.status,
      errmsg: maskToken(text.slice(0, 300), token),
    });
  }
  const body = parseWechatBody(text, token);
  const mediaId = typeof body.media_id === "string" ? body.media_id : "";
  const mediaUrl = typeof body.url === "string" ? body.url : "";
  if (!mediaId) throw new WechatError("微信接口没有返回素材 media_id。");
  return { mediaId, url: mediaUrl, localPath: absolute };
}

/**
 * 上传一张本地图片，取回可以直接写进公众号正文的地址。
 *
 * 走的是「上传图文消息内的图片」这个接口：它只换地址、不进素材库，
 * 不占永久素材配额，正是正文插图该用的那一个。
 * 返回的地址形如 https://mmbiz.qpic.cn/...，公众号服务器能直接取到。
 */
export async function uploadInlineImage(
  localPath: string,
  creds?: WechatCredentials,
): Promise<{ url: string; localPath: string }> {
  const token = await getAccessToken(creds);
  const absolute = path.resolve(localPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    throw new WechatError(`无法读取图片：${path.basename(absolute)}`);
  }
  if (!bytes.length) throw new WechatError("图片内容为空。");

  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(bytes)]), path.basename(absolute));

  const url = `${API_BASE}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`;
  const response = await fetchWithTimeout(url, { method: "POST", body: form }, token);
  const text = await response.text();
  if (!response.ok) {
    throw new WechatError(`上传正文图片失败：HTTP ${response.status}`, {
      status: response.status,
      errmsg: maskToken(text.slice(0, 300), token),
    });
  }
  const body = parseWechatBody(text, token);
  const imageUrl = typeof body.url === "string" ? body.url : "";
  if (!imageUrl) throw new WechatError("微信接口没有返回图片地址。");
  return { url: imageUrl, localPath: absolute };
}

/**
 * 推送到草稿箱。
 *
 * 草稿箱必须带封面图（thumb_media_id），没有就先上传一张再推。
 * 推上去之后用户去公众号后台预览、编辑、发布——稿台不代替人点发布。
 */
export async function createDraft(input: {
  title: string;
  content: string;
  digest?: string;
  author?: string;
  thumbMediaId?: string;
  contentSourceUrl?: string;
  needOpenComment?: 0 | 1;
  onlyFansCanComment?: 0 | 1;
  creds?: WechatCredentials;
}): Promise<{ mediaId: string }> {
  // 本地能查出来的问题先查完再调接口：少一次请求，
  // 而且报错说的是真正的原因——凭据无效时不会把「缺封面」这条提示盖掉。
  if (!input.thumbMediaId) {
    throw new WechatError("公众号草稿需要一张封面图，请先上传封面图再推送。");
  }
  if (!input.title.trim()) throw new WechatError("草稿标题不能为空。");

  const token = await getAccessToken(input.creds);

  const payload = {
    articles: [
      {
        title: input.title.trim(),
        author: input.author?.trim() || "",
        digest: input.digest?.trim() || "",
        content: input.content,
        content_source_url: input.contentSourceUrl?.trim() || "",
        thumb_media_id: input.thumbMediaId,
        need_open_comment: input.needOpenComment ?? 0,
        only_fans_can_comment: input.onlyFansCanComment ?? 0,
      },
    ],
  };

  const url = `${API_BASE}/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`;
  const response = await fetchWithTimeout(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    token,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new WechatError(`推送草稿失败：HTTP ${response.status}`, {
      status: response.status,
      errmsg: maskToken(text.slice(0, 300), token),
    });
  }
  const body = parseWechatBody(text, token);
  const mediaId = typeof body.media_id === "string" ? body.media_id : "";
  if (!mediaId) throw new WechatError("微信接口没有返回草稿 media_id。");
  return { mediaId };
}

/**
 * 更新一条已存在的草稿。
 *
 * 草稿箱没有"编辑"这个用户入口，稿台这边却经常要重推同一篇——用户改两个错别字
 * 不该在草稿箱里再多一份。所以内容变了就更新原来那份（index: 0 指第一条图文，
 * 我们只推单篇），而不是再新建一份。
 *
 * 错误处理与 createDraft 完全对齐：fetchWithTimeout 兜超时、parseWechatBody
 * 统一抛业务错误、maskToken 保证 access_token 永不进错误信息。
 */
export async function updateDraft(input: {
  mediaId: string;
  title: string;
  content: string;
  digest?: string;
  author?: string;
  thumbMediaId?: string;
  contentSourceUrl?: string;
  needOpenComment?: 0 | 1;
  onlyFansCanComment?: 0 | 1;
  creds?: WechatCredentials;
}): Promise<{ mediaId: string }> {
  // 缺 media_id 就无从更新；先本地判掉，别把一句「没传 media_id」变成微信的一句 400。
  if (!input.mediaId.trim()) throw new WechatError("缺少草稿 media_id，无法更新。");
  if (!input.title.trim()) throw new WechatError("草稿标题不能为空。");

  const token = await getAccessToken(input.creds);

  const payload = {
    media_id: input.mediaId.trim(),
    index: 0,
    articles: [
      {
        title: input.title.trim(),
        author: input.author?.trim() || "",
        digest: input.digest?.trim() || "",
        content: input.content,
        content_source_url: input.contentSourceUrl?.trim() || "",
        thumb_media_id: input.thumbMediaId?.trim() || "",
        need_open_comment: input.needOpenComment ?? 0,
        only_fans_can_comment: input.onlyFansCanComment ?? 0,
      },
    ],
  };

  const url = `${API_BASE}/cgi-bin/draft/update?access_token=${encodeURIComponent(token)}`;
  const response = await fetchWithTimeout(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    token,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new WechatError(`更新草稿失败：HTTP ${response.status}`, {
      status: response.status,
      errmsg: maskToken(text.slice(0, 300), token),
    });
  }
  const body = parseWechatBody(text, token);
  // 微信正常情况下回同一个 media_id；个别版本回空时退回入参，避免调用方拿不到 id。
  const mediaId = typeof body.media_id === "string" && body.media_id ? body.media_id : payload.media_id;
  return { mediaId };
}

/**
 * 上传一个本地视频到微信永久素材库。
 *
 * 视频只有「永久素材」这一条路——公众号没有「正文内嵌视频文件」的接口，
 * 正文里要放视频，只能先传成永久素材拿到 media_id，再在图文里引用它。
 *
 * 微信对视频的限制（≤200MB / ≤10 分钟 / MP4）在客户端先判一遍：
 * 这些是本地就能确定的硬约束，没必要花一次上传的代价去换微信的一句 400。
 * description 是 JSON 字符串（{"title":...,"introduction":...}），微信要的就是这个形状。
 *
 * 错误处理与 uploadPermanentImage 对齐：fetchWithTimeout 兜超时、parseWechatBody
 * 统一抛业务错误、maskToken 保证 access_token 永不进错误信息。
 */
export async function uploadVideo(input: {
  localPath: string;
  title: string;
  description: string;
  creds?: WechatCredentials;
}): Promise<{ mediaId: string }> {
  if (!input.title.trim()) throw new WechatError("视频标题不能为空。");

  const token = await getAccessToken(input.creds);
  const absolute = path.resolve(input.localPath);
  let bytes: Buffer;
  let stat;
  try {
    stat = await statFile(absolute);
    bytes = await readFile(absolute);
  } catch {
    throw new WechatError(`无法读取视频：${path.basename(absolute)}`);
  }
  if (!bytes.length) throw new WechatError("视频内容为空。");
  // 200MB 是微信的硬上限。先在本地判掉，省一次几十兆的上传。
  if (stat.size > 200 * 1024 * 1024) {
    throw new WechatError("视频不能超过 200MB，请压缩后再上传。");
  }

  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(bytes)]), path.basename(absolute));
  form.append(
    "description",
    JSON.stringify({ title: input.title.trim(), introduction: input.description?.trim() || "" }),
  );

  const url = `${API_BASE}/cgi-bin/media/uploadvideo?access_token=${encodeURIComponent(token)}`;
  const response = await fetchWithTimeout(url, { method: "POST", body: form }, token);
  const text = await response.text();
  if (!response.ok) {
    throw new WechatError(`上传视频失败：HTTP ${response.status}`, {
      status: response.status,
      errmsg: maskToken(text.slice(0, 300), token),
    });
  }
  const body = parseWechatBody(text, token);
  const mediaId = typeof body.media_id === "string" ? body.media_id : "";
  if (!mediaId) throw new WechatError("微信接口没有返回视频 media_id。");
  return { mediaId };
}

/** 拉取已发布文章。 */
export async function listPublished(creds?: WechatCredentials): Promise<{ total: number; items: PublishedArticle[] }> {
  const token = await getAccessToken(creds);
  const url = `${API_BASE}/cgi-bin/freepublish/batchget?access_token=${encodeURIComponent(token)}&offset=0&count=20`;
  const response = await fetchWithTimeout(url, { method: "GET" }, token);
  const text = await response.text();
  if (!response.ok) {
    throw new WechatError(`拉取已发布文章失败：HTTP ${response.status}`, {
      status: response.status,
      errmsg: maskToken(text.slice(0, 300), token),
    });
  }
  const body = parseWechatBody(text, token);
  const total = typeof body.total_count === "number" ? body.total_count : 0;
  const list = Array.isArray(body.item) ? (body.item as Record<string, unknown>[]) : [];
  const items: PublishedArticle[] = list.map(item => {
    const articleId = String(item.article_id ?? "");
    const content = String(item.content ?? "");
    return {
      articleId,
      title: String(item.title ?? ""),
      author: String(item.author ?? ""),
      digest: String(item.digest ?? ""),
      url: String(item.url ?? ""),
      updateTime: Number(item.update_time ?? 0),
      ...(content ? { content } : {}),
    };
  });
  return { total, items };
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * 图文数据统计。
 *
 * 微信的统计接口按天返回，缺字段补 0——不补的话前端还得到处判空。
 */
export async function getArticleStats(creds?: WechatCredentials): Promise<ArticleStat[]> {
  const token = await getAccessToken(creds);
  const end = new Date();
  const begin = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  const url =
    `${API_BASE}/cgi-bin/datacube/getarticlesummary?access_token=${encodeURIComponent(token)}` +
    `&begin_date=${formatDate(begin)}&end_date=${formatDate(end)}`;

  const response = await fetchWithTimeout(url, { method: "GET" }, token);
  const text = await response.text();
  if (!response.ok) {
    throw new WechatError(`拉取统计数据失败：HTTP ${response.status}`, {
      status: response.status,
      errmsg: maskToken(text.slice(0, 300), token),
    });
  }
  const body = parseWechatBody(text, token);
  const list = Array.isArray(body.list) ? (body.list as Record<string, unknown>[]) : [];
  return list.map(item => ({
    articleId: String(item.msgid ?? item.article_id ?? ""),
    title: String(item.title ?? ""),
    readCount: Number(item.read_num ?? item.read_count ?? 0) || 0,
    likeCount: Number(item.like_num ?? item.like_count ?? 0) || 0,
    shareCount: Number(item.share_num ?? item.share_count ?? 0) || 0,
    commentCount: Number(item.comment_count ?? 0) || 0,
    publishDate: typeof item.date === "string" ? item.date : undefined,
  }));
}
