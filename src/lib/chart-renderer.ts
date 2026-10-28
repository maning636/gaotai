import { createCanvas, type CanvasRenderingContext2D } from "canvas";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createId } from "./ids";
import { ensureImageDir, imageDir } from "./files";
import type { ChartSpec } from "./chart-spec";

/**
 * 图解渲染器：把 ChartSpec 画成 PNG。
 *
 * 为什么是 canvas 而不是 HTML：
 * - 公众号不执行 JS，粘 ECharts/Chart.js 的 HTML 进去是死图；
 * - 复杂 SVG 在部分客户端会被吃掉；
 * - PNG 走我们已有的图片管线（上传、插图、推草稿换微信地址）最稳。
 *
 * 视觉语言：白底、黑字、一条强调色、细线；跟稿台的排版模板是同一套口味。
 * 选型与视觉原则参考了 lieflat-charts 与 show-me，实现为本项目自研。
 */

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const INK = "#1A1A1A";
const MUTED = "#6B6459";
const LINE = "#D9D2C3";
const SURFACE = "#F5F2E8";
const DEFAULT_ACCENT = "#F7D54A";
const DEFAULT_WIDTH = 1000; // CSS 宽；输出 2x = 2000px，卡在公众号 2000px 红线内
const DEFAULT_SCALE = 2;
const PAD = 56;

/**
 * 渲染参数。
 *
 * 正文出图走默认值（1000 CSS 宽 × 2 = 2000px，与历史行为一致）；
 * 图例缩略图用更小尺寸（见 `/api/illustration/samples`），
 * 但所有绘制逻辑都以 CSS 像素为单位，靠 scale 放大输出，
 * 因此换尺寸不会改变版式比例。
 */
export type ChartRenderOptions = {
  /** CSS 逻辑宽度。缺省 1000（保持既有出图尺寸）。 */
  width?: number;
  /** 输出倍率。缺省 2（保持既有出图尺寸）。 */
  scale?: number;
};

/** 画布 CSS 逻辑宽度。 */
function cssWidth(options: ChartRenderOptions): number {
  return options.width ?? DEFAULT_WIDTH;
}

/** 输出倍率。 */
function outputScale(options: ChartRenderOptions): number {
  return options.scale ?? DEFAULT_SCALE;
}

const WAFFLE_SHADES = ["#1A1A1A", "#F7D54A", "#2F6F5E", "#C4553B", "#3D7BFF", "#8B6BB1"];

function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

function wrap(text: string, maxChars: number, maxLines = 2): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = "";
  for (const ch of chars) {
    current += ch;
    if (Array.from(current).length >= maxChars) {
      lines.push(current);
      current = "";
      if (lines.length >= maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === 0) return [""];
  return lines.slice(0, maxLines);
}

function accentOf(spec: ChartSpec): string {
  return spec.accent ?? DEFAULT_ACCENT;
}

/** 按内容估算画布高度（CSS 像素）。 */
function heightOf(spec: ChartSpec): number {
  switch (spec.kind) {
    case "bar":
      return 190 + spec.rows.length * 58 + 80;
    case "waffle":
      return 680;
    case "timeline":
      return 170 + spec.items.length * 118 + 80;
    case "compare":
      return 200 + compareCardHeight(spec) + 70;
    case "steps":
      return 180 + spec.steps.length * 112 + 70;
    case "kpi":
      return 680;
  }
}

function compareCardHeight(spec: Extract<ChartSpec, { kind: "compare" }>): number {
  const points = Math.max(spec.left.points.length, spec.right.points.length);
  return Math.min(440, 150 + points * 58);
}

/** 统一页头：强调色条、标题、副标题；返回正文起始 y。 */
function drawHeader(ctx: CanvasRenderingContext2D, spec: ChartSpec, width: number): number {
  const accent = accentOf(spec);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, heightOf(spec));

  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, width, 10);

  setFont(ctx, 700, 38);
  ctx.fillStyle = INK;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const titleLines = wrap(spec.title, 20, 2);
  titleLines.forEach((line, index) => {
    ctx.fillText(line, PAD, 56 + index * 48);
  });

  let y = 56 + titleLines.length * 48;
  if (spec.subtitle) {
    setFont(ctx, 400, 19);
    ctx.fillStyle = MUTED;
    const subLines = wrap(spec.subtitle, 34, 2);
    subLines.forEach((line, index) => {
      ctx.fillText(line, PAD, y + 8 + index * 26);
    });
    y += subLines.length * 26 + 8;
  }
  return y + 34;
}

function drawFooter(ctx: CanvasRenderingContext2D, spec: ChartSpec, h: number, width: number) {
  if (!spec.source) return;
  setFont(ctx, 400, 14);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(`来源：${spec.source}`, width - PAD, h - 24);
}

function drawBar(ctx: CanvasRenderingContext2D, spec: Extract<ChartSpec, { kind: "bar" }>, top: number, h: number, width: number) {
  const accent = accentOf(spec);
  const labelWidth = 210;
  const trackX = PAD + labelWidth;
  const trackWidth = width - PAD * 2 - labelWidth - 110;
  const max = Math.max(...spec.rows.map((row) => row.value), 1);
  const rowH = 58;
  const barH = 26;

  spec.rows.forEach((row, index) => {
    const y = top + index * rowH;
    setFont(ctx, 500, 18);
    ctx.fillStyle = INK;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(wrap(row.label, 10, 1)[0], PAD + labelWidth - 16, y + barH / 2 + 2);

    ctx.fillStyle = SURFACE;
    ctx.fillRect(trackX, y, trackWidth, barH);

    ctx.fillStyle = accent;
    ctx.fillRect(trackX, y, Math.max(4, (row.value / max) * trackWidth), barH);

    setFont(ctx, 700, 17);
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const valueText = spec.unit ? `${row.value} ${spec.unit}` : String(row.value);
    ctx.fillText(valueText, trackX + Math.max(4, (row.value / max) * trackWidth) + 12, y + barH / 2 + 1);
  });

  drawFooter(ctx, spec, h, width);
}

function drawWaffle(ctx: CanvasRenderingContext2D, spec: Extract<ChartSpec, { kind: "waffle" }>, top: number, h: number, width: number) {
  const total = spec.segments.reduce((sum, item) => sum + item.value, 0);
  const counts = spec.segments.map((item) => Math.round((item.value / total) * 100));
  // 四舍五入可能差 1–2 格，补到第一段，保证正好 100。
  const diff = 100 - counts.reduce((sum, n) => sum + n, 0);
  counts[0] += diff;

  const cell = 30;
  const gap = 6;
  const gridW = cell * 10 + gap * 9;
  const gridX = (width - gridW) / 2;
  const gridY = top + 10;
  let index = 0;

  for (let row = 0; row < 10; row += 1) {
    for (let col = 0; col < 10; col += 1) {
      let segment = 0;
      while (index >= counts.slice(0, segment + 1).reduce((sum, n) => sum + n, 0)) segment += 1;
      const color = spec.segments[segment] ? WAFFLE_SHADES[segment % WAFFLE_SHADES.length] : SURFACE;
      ctx.fillStyle = color;
      ctx.fillRect(gridX + col * (cell + gap), gridY + row * (cell + gap), cell, cell);
      index += 1;
    }
  }

  // 图例
  const legendY = gridY + gridW + 24;
  let x = gridX;
  spec.segments.forEach((item, i) => {
    ctx.fillStyle = WAFFLE_SHADES[i % WAFFLE_SHADES.length];
    ctx.fillRect(x, legendY, 14, 14);
    setFont(ctx, 400, 16);
    ctx.fillStyle = INK;
    ctx.textBaseline = "middle";
    const text = `${item.label} ${Math.round((item.value / total) * 100)}%`;
    ctx.fillText(text, x + 22, legendY + 8);
    x += 22 + ctx.measureText(text).width + 28;
  });

  drawFooter(ctx, spec, h, width);
}

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  spec: Extract<ChartSpec, { kind: "timeline" }>,
  top: number,
  h: number,
  width: number,
) {
  const accent = accentOf(spec);
  const lineX = PAD + 96;
  const itemH = 118;

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(lineX, top + 8);
  ctx.lineTo(lineX, top + (spec.items.length - 1) * itemH + 8);
  ctx.stroke();

  spec.items.forEach((item, index) => {
    const y = top + index * itemH;
    setFont(ctx, 600, 15);
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(item.date, lineX - 26, y - 2);

    ctx.beginPath();
    ctx.arc(lineX, y + 6, 7, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();

    setFont(ctx, 600, 21);
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.fillText(item.title, lineX + 28, y - 4);

    if (item.detail) {
      setFont(ctx, 400, 16);
      ctx.fillStyle = MUTED;
      const lines = wrap(item.detail, 38, 2);
      lines.forEach((line, i) => ctx.fillText(line, lineX + 28, y + 28 + i * 22));
    }
  });

  drawFooter(ctx, spec, h, width);
}

function drawCompare(
  ctx: CanvasRenderingContext2D,
  spec: Extract<ChartSpec, { kind: "compare" }>,
  top: number,
  h: number,
  width: number,
) {
  const accent = accentOf(spec);
  const cardW = (width - PAD * 2 - 40) / 2;
  const cardH = compareCardHeight(spec);
  const drawCard = (x: number, side: typeof spec.left, filled: boolean) => {
    ctx.fillStyle = filled ? accent : "#FFFFFF";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.fillRect(x, top, cardW, cardH);
    ctx.strokeRect(x, top, cardW, cardH);

    setFont(ctx, 700, 24);
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(side.label, x + 24, top + 24);

    let y = top + 74;
    side.points.forEach((point) => {
      ctx.fillStyle = INK;
      ctx.fillRect(x + 24, y + 8, 7, 7);
      setFont(ctx, 400, 17);
      const lines = wrap(point, 18, 2);
      lines.forEach((line, i) => ctx.fillText(line, x + 42, y + i * 24));
      y += lines.length * 24 + 18;
    });
  };

  drawCard(PAD, spec.left, false);
  drawCard(PAD + cardW + 40, spec.right, true);

  setFont(ctx, 700, 16);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("VS", width / 2, top + cardH / 2);

  drawFooter(ctx, spec, h, width);
}

function drawSteps(
  ctx: CanvasRenderingContext2D,
  spec: Extract<ChartSpec, { kind: "steps" }>,
  top: number,
  h: number,
  width: number,
) {
  const accent = accentOf(spec);
  const dotX = PAD + 28;
  const itemH = 112;

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(dotX, top + 14);
  ctx.lineTo(dotX, top + (spec.steps.length - 1) * itemH + 14);
  ctx.stroke();

  spec.steps.forEach((step, index) => {
    const y = top + index * itemH;
    ctx.beginPath();
    ctx.arc(dotX, y + 14, 20, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();

    setFont(ctx, 700, 18);
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(index + 1), dotX, y + 15);

    setFont(ctx, 600, 22);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(step.title, dotX + 44, y);

    if (step.detail) {
      setFont(ctx, 400, 16);
      ctx.fillStyle = MUTED;
      const lines = wrap(step.detail, 34, 2);
      lines.forEach((line, i) => ctx.fillText(line, dotX + 44, y + 34 + i * 22));
    }
  });

  drawFooter(ctx, spec, h, width);
}

function drawKpi(ctx: CanvasRenderingContext2D, spec: Extract<ChartSpec, { kind: "kpi" }>, top: number, h: number, width: number) {
  const accent = accentOf(spec);
  const cols = spec.items.length === 1 ? 1 : 2;
  const cardW = (width - PAD * 2 - (cols - 1) * 24) / cols;
  const cardH = 150;

  spec.items.forEach((item, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = PAD + col * (cardW + 24);
    const y = top + row * (cardH + 24);

    ctx.fillStyle = index === 0 ? accent : "#FFFFFF";
    ctx.fillRect(x, y, cardW, cardH);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, cardW, cardH);

    setFont(ctx, 400, 16);
    ctx.fillStyle = MUTED;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(wrap(item.label, 16, 1)[0], x + 22, y + 20);

    setFont(ctx, 700, 44);
    ctx.fillStyle = INK;
    ctx.fillText(item.value, x + 22, y + 50);

    if (item.delta) {
      setFont(ctx, 600, 15);
      ctx.fillStyle = item.delta.startsWith("-") ? "#B23A2E" : "#2F6F5E";
      ctx.fillText(item.delta, x + 22, y + 112);
    }
  });

  drawFooter(ctx, spec, h, width);
}

/**
 * 把 ChartSpec 画成 PNG，纯函数：不落盘、不依赖 imagesDir。
 *
 * 返回的是输出像素尺寸（CSS 宽 × 输出倍率）。默认参数与既有行为一致
 * （1000 CSS 宽 × 2 = 2000px），图例缩略图传更小的 width/scale 即可。
 */
export function renderChartPng(
  spec: ChartSpec,
  options: ChartRenderOptions = {},
): { buffer: Buffer; width: number; height: number } {
  const width = cssWidth(options);
  const scale = outputScale(options);
  const cssHeight = heightOf(spec);
  const canvas = createCanvas(width * scale, cssHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  const top = drawHeader(ctx, spec, width);
  switch (spec.kind) {
    case "bar":
      drawBar(ctx, spec, top, cssHeight, width);
      break;
    case "waffle":
      drawWaffle(ctx, spec, top, cssHeight, width);
      break;
    case "timeline":
      drawTimeline(ctx, spec, top, cssHeight, width);
      break;
    case "compare":
      drawCompare(ctx, spec, top, cssHeight, width);
      break;
    case "steps":
      drawSteps(ctx, spec, top, cssHeight, width);
      break;
    case "kpi":
      drawKpi(ctx, spec, top, cssHeight, width);
      break;
  }

  const buffer = canvas.toBuffer("image/png");
  return { buffer, width: width * scale, height: cssHeight * scale };
}

export async function buildChartPng(spec: ChartSpec): Promise<{ buffer: Buffer; width: number; height: number }> {
  return renderChartPng(spec);
}

export async function renderChart(
  spec: ChartSpec,
): Promise<{ url: string; path: string; size: number; width: number; height: number }> {
  await ensureImageDir();
  const { buffer, width, height } = renderChartPng(spec);
  const relPath = `${Date.now()}-${createId("chart").slice(0, 8)}.png`;
  const abs = path.join(imageDir(), relPath);
  await fs.writeFile(abs, buffer);
  return { url: `/api/files/img/${relPath}`, path: relPath, size: buffer.length, width, height };
}
