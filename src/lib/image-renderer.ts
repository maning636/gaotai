import { createCanvas } from "canvas";
import { promises as fs } from "node:fs";
import path from "node:path";
import { imageDir, ensureImageDir } from "./files";
import { createId } from "./ids";
import { imagesDir } from "./paths";

/**
 * 程序化渲染装饰性图片卡片（"HDMI 渲染"的落地实现：本地用 node-canvas 直接绘制，
 * 不依赖外部图像 API）。用户输入的视觉提示词通过 SVG 描述符渲染成 Neo-Brutalist
 * 风格的 PNG，落到 .tmp/images/ 目录，返回相对 URL 供 markdown 引用。
 *
 * 输出规格：900x600，PNG，体积 ~90KB（微信正文内联图上限 1MB 内），
 * 中文字体走系统 fontconfig（Windows 用 msyh.ttc）。
 */

export type RenderSpec = {
  title: string;
  subtitle?: string;
  tag?: string;
  accent?: "pink" | "yellow" | "blue" | "green";
  width?: number;
  height?: number;
};

const ACCENTS: Record<string, { bg: string; text: string; line: string }> = {
  pink: { bg: "#FF5FA2", text: "#FFFFFF", line: "#0F0F0F" },
  yellow: { bg: "#FFD429", text: "#0F0F0F", line: "#0F0F0F" },
  blue: { bg: "#3D7BFF", text: "#FFFFFF", line: "#0F0F0F" },
  green: { bg: "#2FD07A", text: "#0F0F0F", line: "#0F0F0F" },
};

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let cur: string[] = [];
  for (const ch of chars) {
    cur.push(ch);
    if (cur.join("").length >= maxChars) {
      lines.push(cur.join(""));
      cur = [];
      if (lines.length >= maxLines) break;
    }
  }
  if (lines.length < maxLines && cur.length) lines.push(cur.join(""));
  return lines.slice(0, maxLines);
}

// 优先用系统中文字体，找不到时降级到通用 sans-serif
const FONT_SANS = '"Microsoft YaHei", "PingFang SC", sans-serif';
const FONT_MONO = '"Consolas", "JetBrains Mono", monospace';

function setFont(ctx: import("canvas").CanvasRenderingContext2D, family: string, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${family}`;
}

export function buildCardSvg(spec: RenderSpec): string {
  // 保留 buildCardSvg 导出用于单元测试和调试，主渲染走 buildCardPng。
  // 这里只返回一段简单 SVG（无中文字体要求），避免 sharp 处理中文。
  const w = spec.width ?? 900, h = spec.height ?? 600;
  const accent = ACCENTS[spec.accent ?? "yellow"];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${accent.bg}"/></svg>`;
}

export async function buildCardPng(spec: RenderSpec): Promise<Buffer> {
  const w = spec.width ?? 900, h = spec.height ?? 600;
  const accent = ACCENTS[spec.accent ?? "yellow"] ?? ACCENTS.yellow;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // 背景
  ctx.fillStyle = accent.bg;
  ctx.fillRect(0, 0, w, h);

  // 粗黑描边（外框）
  ctx.fillStyle = "#0F0F0F";
  ctx.fillRect(0, 0, w, 14);
  ctx.fillRect(0, h - 14, w, 14);
  ctx.fillRect(0, 0, 14, h);
  ctx.fillRect(w - 14, 0, 14, h);

  // 左上装饰标签
  const tagText = spec.tag ?? "VISUAL";
  setFont(ctx, FONT_MONO, 700, 20);
  const tagWidth = ctx.measureText(tagText).width + 24;
  const tagX = 50, tagY = 60;
  ctx.fillStyle = "#0F0F0F";
  ctx.fillRect(tagX, tagY, tagWidth, 42);
  ctx.fillStyle = "#FFD429";
  ctx.textBaseline = "middle";
  ctx.fillText(tagText, tagX + 12, tagY + 22);

  // 主标题（最多 3 行）
  const titleLines = wrap(spec.title || "无标题", 12, 3);
  const titleFont = 88;
  setFont(ctx, FONT_SANS, 900, titleFont);
  ctx.fillStyle = accent.text;
  ctx.textBaseline = "top";
  const titleY = 170;
  titleLines.forEach((line, i) => {
    ctx.fillText(line, 50, titleY + i * (titleFont + 12));
  });

  // 装饰横线
  const lineY = titleY + titleLines.length * (titleFont + 12) + 20;
  ctx.fillStyle = accent.text;
  ctx.fillRect(50, lineY, 120, 6);

  // 副标题
  if (spec.subtitle) {
    const subLines = wrap(spec.subtitle, 30, 2);
    setFont(ctx, FONT_SANS, 500, 24);
    subLines.forEach((line, i) => {
      ctx.fillText(line, 50, lineY + 40 + i * 32);
    });
  }

  // 右下装饰圆形贴纸
  const cx = w - 100, cy = h - 100;
  ctx.beginPath();
  ctx.arc(cx, cy, 60, 0, Math.PI * 2);
  ctx.fillStyle = "#0F0F0F";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 52, 0, Math.PI * 2);
  ctx.fillStyle = "#FFD429";
  ctx.fill();
  setFont(ctx, FONT_MONO, 900, 18);
  ctx.fillStyle = "#0F0F0F";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("WE", cx, cy - 10);
  ctx.fillText("ART", cx, cy + 12);

  return canvas.toBuffer("image/png");
}

export async function renderCard(spec: RenderSpec): Promise<{ url: string; path: string; size: number; dataUri: string }> {
  await ensureImageDir();
  const buf = await buildCardPng(spec);
  const relPath = `${Date.now()}-${createId("img").slice(0, 8)}.png`;
  const abs = path.join(imageDir(), relPath);
  await fs.writeFile(abs, buf);
  const dataUri = `data:image/png;base64,${buf.toString("base64")}`;
  return { url: `/api/files/img/${relPath}`, path: relPath, size: buf.length, dataUri };
}

// 供"复制到公众号"使用：把本地文件读成 base64 data URI，iframe 预览与 clipboard 都能识别。
export async function imageToDataUri(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase() || ".png";
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : "image/png";
  try {
    const buf = await fs.readFile(filePath);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch { return null; }
}

/**
 * 把 HTML 中所有 `/api/files/img/<basename>` 的图片 src 转成 data URI。
 * 用途：iframe 预览时把本地图内联，绕开 srcDoc iframe 的 origin 限制。
 * 返回替换后的 HTML；无匹配时原样返回。
 *
 * 地址里的文件名是**百分号编码**过的（生图产物带中文名），
 * 磁盘上的文件名是解码后的——不解码就找不到文件，预览里会是一张裂图。
 */
export async function inlineLocalImages(html: string): Promise<string> {
  const sources = [...html.matchAll(/<img\s+[^>]*?\bsrc="(\/api\/files\/img\/[^"]+)"/g)];
  if (sources.length === 0) return html;
  let result = html;
  for (const match of sources) {
    const src = match[1];
    const encoded = src.replace(/^\/api\/files\/img\//, "").split("/").pop() ?? "";
    if (!encoded) continue;
    let basename = encoded;
    try {
      basename = decodeURIComponent(encoded);
    } catch {
      // 不合法的编码就按原样试。
    }
    const filePath = path.join(imagesDir(), basename);
    const dataUri = await imageToDataUri(filePath);
    if (!dataUri) continue;
    result = result.split(match[0]).join(match[0].replace(src, dataUri));
  }
  return result;
}
