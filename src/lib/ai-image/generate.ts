import { readAgentConfig } from "../agent-config-store";

/**
 * AI 生图。
 *
 * 走模型配置里的 OpenAI 兼容端点（/images/generations），密钥不落前端：
 * 这个模块只在服务端（API 路由）里被 import。
 *
 * 两条返回路径都要能接住：
 * - 同步返回：data[].b64_json 或 data[].url；
 * - 异步任务：接口回 { task_id }，轮询 ${base}/tasks/{taskId}。
 */

export type GenerateImageOptions = {
  prompt: string;
  size?: "256x256" | "512x512" | "1024x1024";
  n?: number;
};

export type GeneratedImage = {
  /** base64 编码的图。没配 response_format 的端点会走 url。 */
  b64Json?: string;
  /** 图片地址。 */
  url?: string;
};

/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 2_500;
/** 异步任务总超时（毫秒）。 */
const POLL_TIMEOUT_MS = 90_000;

/** 单次请求超时（毫秒）。异步任务只等任务本身，不等生成过程。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 生成一张或多张图。
 *
 * 未配置 apiKey 时抛明确错误；HTTP/服务端错误带状态码与详情。
 */
export async function generateImage(options: GenerateImageOptions): Promise<GeneratedImage[]> {
  const config = await readAgentConfig();
  if (!config.apiKey?.trim()) {
    throw new Error("尚未配置模型 API Key。请到「模型」页面填入密钥后再试。");
  }
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("请先输入配图主题。");

  const base = config.apiBaseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        prompt,
        size: options.size ?? "1024x1024",
        n: options.n ?? 1,
        response_format: "b64_json",
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `AI 生图失败（HTTP ${response.status}）：${text.slice(0, 300).replace(/\s+/g, " ").trim() || "未知错误"}`,
      );
    }
    const body = JSON.parse(text) as {
      data?: { b64_json?: string; url?: string }[];
      task_id?: string;
      status?: string;
      error?: { message?: string };
    };
    if (body.error?.message) throw new Error(`AI 生图报错：${body.error.message}`);
    // 异步任务：等它跑完再取结果。
    if (body.task_id) return await pollTask(base, config.apiKey, body.task_id);
    const images: GeneratedImage[] = [];
    for (const item of body.data ?? []) {
      if (item.b64_json) images.push({ b64Json: item.b64_json });
      else if (item.url) images.push({ url: item.url });
    }
    if (!images.length) throw new Error("AI 生图接口没有返回图片。");
    return images;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("AI 生图请求超时，请重试。", { cause: error });
    }
    if (error instanceof SyntaxError) {
      throw new Error("AI 生图接口返回的不是合法 JSON。", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 轮询异步生图任务。
 *
 * 部分端点 /images/generations 立即回一个 task_id，图片要等会儿才好。
 * 每 2.5s 问一次，累计超过 90s 放弃。
 */
async function pollTask(base: string, apiKey: string, taskId: string): Promise<GeneratedImage[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `查询生图任务失败（HTTP ${response.status}）：${text.slice(0, 300).replace(/\s+/g, " ").trim() || "未知错误"}`,
        );
      }
      const body = JSON.parse(text) as {
        status?: string;
        data?: { b64_json?: string; url?: string }[];
        error?: { message?: string };
      };
      if (body.error?.message) throw new Error(`生图任务报错：${body.error.message}`);
      // 任务还没好：status 可能是 pending / queued / running / processing。
      if (body.status && /^(pending|queued|running|processing|in_progress)$/i.test(body.status)) continue;
      const images: GeneratedImage[] = [];
      for (const item of body.data ?? []) {
        if (item.b64_json) images.push({ b64Json: item.b64_json });
        else if (item.url) images.push({ url: item.url });
      }
      if (images.length) return images;
      if (body.status && /^(succeeded|success|completed|done)$/i.test(body.status)) {
        throw new Error("生图任务已完成，但接口没有返回图片。");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("查询生图任务超时。", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("AI 生图等待超时（90 秒），请稍后重试。");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
