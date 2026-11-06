/**
 * Unsplash 图库搜索。
 *
 * 只在服务端（API 路由）里用：API Key 来自 process.env.UNSPLASH_ACCESS_KEY，
 * 不能落到前端。没配 key 时相关接口抛明确错误，前端 Unsplash Tab 禁用。
 */

export type UnsplashPhoto = {
  id: string;
  urls: {
    regular: string;
    small: string;
    thumb: string;
  };
  width: number;
  height: number;
  alt_description: string | null;
  links: {
    download_location: string;
  };
};

export type UnsplashOrientation = "landscape" | "portrait" | "squarish";

const API_BASE = "https://api.unsplash.com";

/** 没配置时抛的明确错误。 */
export function unsplashKeyError(): Error {
  return new Error(
    "未配置 UNSPLASH_ACCESS_KEY。请在 .env 里填入 Unsplash Access Key 后重启，才能使用图库搜索。",
  );
}

function accessKey(): string {
  const key = process.env.UNSPLASH_ACCESS_KEY?.trim();
  if (!key) throw unsplashKeyError();
  return key;
}

/**
 * 按关键词搜索。
 *
 * 每页 30 张。orientation 可选 landscape / portrait / squarish。
 */
export async function searchPhotos(
  query: string,
  page = 1,
  orientation?: UnsplashOrientation,
): Promise<UnsplashPhoto[]> {
  const key = accessKey();
  const params = new URLSearchParams({ query, page: String(page), per_page: "30" });
  if (orientation) params.set("orientation", orientation);
  const response = await fetch(`${API_BASE}/search/photos?${params.toString()}`, {
    headers: { Authorization: `Client-ID ${key}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Unsplash 搜索失败（HTTP ${response.status}）：${text.slice(0, 200).replace(/\s+/g, " ").trim()}`);
  }
  const body = JSON.parse(text) as { results?: unknown[] };
  return normalizePhotos(body.results ?? []);
}

/**
 * 随机图。
 *
 * @param count 1-30。
 * @param orientation 可选 landscape / portrait / squarish。
 */
export async function randomPhotos(count = 10, orientation?: UnsplashOrientation): Promise<UnsplashPhoto[]> {
  const key = accessKey();
  const params = new URLSearchParams({ count: String(Math.min(30, Math.max(1, count))) });
  if (orientation) params.set("orientation", orientation);
  const response = await fetch(`${API_BASE}/photos/random?${params.toString()}`, {
    headers: { Authorization: `Client-ID ${key}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Unsplash 随机图失败（HTTP ${response.status}）：${text.slice(0, 200).replace(/\s+/g, " ").trim()}`);
  }
  const body = JSON.parse(text) as unknown[] | { results?: unknown[] };
  const raw = Array.isArray(body) ? body : (body.results ?? []);
  return normalizePhotos(raw);
}

/** 拉一张原图转 base64。用于把选中的图收进本地素材库。 */
export async function downloadAsBase64(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`下载图片失败（HTTP ${response.status}）。`);
  }
  const bytes = await response.arrayBuffer();
  const type = response.headers.get("content-type") ?? "image/jpeg";
  const buffer = Buffer.from(bytes);
  return `data:${type};base64,${buffer.toString("base64")}`;
}

/**
 * 上报下载事件。
 *
 * Unsplash 协议要求：下载用户点击的图片时，POST 它的 download_location，
 * 否则账号会被限流。这里 fire-and-forget，失败不影响使用。
 */
export async function trackDownload(downloadLocation: string): Promise<void> {
  const key = accessKey();
  try {
    await fetch(downloadLocation, {
      method: "POST",
      headers: { Authorization: `Client-ID ${key}` },
    });
  } catch {
    // 上报失败不阻断流程：这只是统计事件。
  }
}

/** 只保留协议需要的字段，滤掉缺 urls 的坏条目。 */
function normalizePhotos(raw: unknown[]): UnsplashPhoto[] {
  const result: UnsplashPhoto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as {
      id?: unknown;
      urls?: { regular?: unknown; small?: unknown; thumb?: unknown };
      width?: unknown;
      height?: unknown;
      alt_description?: unknown;
      links?: { download_location?: unknown };
    };
    const id = typeof entry.id === "string" ? entry.id : "";
    const regular = typeof entry.urls?.regular === "string" ? entry.urls.regular : "";
    const small = typeof entry.urls?.small === "string" ? entry.urls.small : "";
    const thumb = typeof entry.urls?.thumb === "string" ? entry.urls.thumb : "";
    if (!id || !regular || !small || !thumb) continue;
    result.push({
      id,
      urls: { regular, small, thumb },
      width: typeof entry.width === "number" ? entry.width : 0,
      height: typeof entry.height === "number" ? entry.height : 0,
      alt_description: typeof entry.alt_description === "string" ? entry.alt_description : null,
      links: {
        download_location:
          typeof entry.links?.download_location === "string" ? entry.links.download_location : "",
      },
    });
  }
  return result;
}
