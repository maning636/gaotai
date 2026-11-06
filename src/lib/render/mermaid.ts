import { JSDOM } from "jsdom";
import { createCanvas, loadImage } from "canvas";
import type { Canvas } from "canvas";
import mermaid from "mermaid";

/**
 * Mermaid 图表 → PNG dataURL。
 *
 * 稿台渲染的结果要粘进公众号编辑器。公众号不执行脚本，mermaid 的
 * 动态渲染在那边跑不起来，所以必须在 Node 端先把图表渲染成位图，
 * 输出 `<img src="data:image/png;base64,...">`——PNG 是位图，公众号照单全收。
 *
 * mermaid 在 Node 环境需要 DOM（它内部用 document/navigator/SVGElement 等），
 * 所以这里起一个 jsdom 实例垫底，并补上 canvas 缺的 getBBox/getCTM。
 * 只做一次：DOM 是全局单例，mermaid 也全局只初始化一次。
 */

/**
 * 给 mermaid 垫一个 DOM 环境。
 *
 * Node 24 里 navigator 是只读 getter，直接赋值会抛 TypeError，
 * 得用 Object.defineProperty 覆盖。其余全局从 jsdom 窗口抄过来。
 * getBBox / getCTM 是真实浏览器 SVG 的布局查询，jsdom 不实现——
 * mermaid 布局时拿它量节点，补一个固定 100×100 的近似值即可（布局
 * 只关心相对位置，绝对值由 viewBox 决定）。
 */
function ensureDom(): void {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const w = dom.window;
  // jsdom 的 window 类型与 TS 全局 Window 不兼容（self 属性形状不同），
  // 这里只抄我们需要的字段，用 unknown 桥一下。
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = w;
  g.document = w.document;
  Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true });
  g.DOMParser = w.DOMParser;
  g.SVGElement = w.SVGElement;
  g.Element = w.Element;
  g.XMLSerializer = w.XMLSerializer;
  g.getComputedStyle = w.getComputedStyle;
  g.Node = w.Node;
  g.HTMLElement = w.HTMLElement;
  g.HTMLIFrameElement = w.HTMLIFrameElement;
  g.MutationObserver = w.MutationObserver;
  g.CSSStyleSheet = w.CSSStyleSheet;
  g.CSSRule = w.CSSRule;
  g.CSSStyleDeclaration = w.CSSStyleDeclaration;
  g.Blob = w.Blob;
  // URL 是 Node 自带类，这里保留 Node 的但补上 mermaid 会用的两个方法。
  if (typeof globalThis.URL.createObjectURL !== "function") {
    globalThis.URL.createObjectURL = () => "blob:gaotai";
  }
  if (typeof globalThis.URL.revokeObjectURL !== "function") {
    globalThis.URL.revokeObjectURL = () => undefined;
  }
  // 真实浏览器的 SVG 布局查询，jsdom 不实现——mermaid 用它量节点。
  const proto = w.SVGElement.prototype as unknown as Record<string, unknown>;
  proto.getBBox = function getBBox() {
    return { x: 0, y: 0, width: 100, height: 100 };
  };
  proto.getCTM = function getCTM() {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  };
  proto.getScreenCTM = function getScreenCTM() {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  };
}

/** 每个 mermaid 渲染实例的 id 必须唯一，否则 mermaid 内部状态串台。 */
let nextId = 0;

/** 当前主题配置（%%{init}%% 注入用），首次渲染时读取。 */
export type MermaidTheme = {
  theme: string;
  background: string;
  primaryColor: string;
  primaryTextColor: string;
  lineColor: string;
};

// mermaid 全局只在第一次调用时初始化一次（重复 initialize 会警告并重置）。
let initialized = false;

/**
 * 渲染 Mermaid 源码为 SVG 字符串。
 *
 * 先注入 `%%{init}%%` 主题指令，保证配色跟稿台主题一致；再用
 * mermaid.render 转成 SVG。失败时抛错，由调用方兜底成代码原文。
 */
export async function renderMermaidToSvg(source: string, theme?: Partial<MermaidTheme>): Promise<string> {
  ensureDom();
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      securityLevel: "loose",
      // 用 loose：公众号场景我们完全信任自己渲染的图，不需要 mermaid 再净化一遍。
      // 而且 loose 下 mermaid 不额外插脚本，输出是纯 SVG。
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    });
    initialized = true;
  }
  const mermaidApi = mermaid as unknown as {
    render: (id: string, source: string) => Promise<{ svg: string }>;
  };

  // 注入主题：base 主题 + 一组与稿台一致的色值。mermaid 的 base 主题
  // 支持用 init 覆盖 primaryColor / primaryTextColor / lineColor / background。
  const init = theme && Object.keys(theme).length ? theme : defaultTheme();
  const directive = `%%{init: ${JSON.stringify({ theme: "base", ...init })}}%%`;
  const id = `gm-${nextId++}`;
  const result = await mermaidApi.render(id, `${directive}\n${source}`);
  return result.svg;
}

/** 默认配色：跟代码块 GitHub Dark 拉通，图表也走深底浅字。 */
function defaultTheme(): MermaidTheme {
  return {
    theme: "base",
    background: "#0d1117",
    primaryColor: "#1f6feb",
    primaryTextColor: "#f0f6fc",
    lineColor: "#8b949e",
  };
}

/**
 * 把 SVG 栅格化成 PNG dataURL。
 *
 * mermaid 输出的 svg 自带 `width="100%"`，canvas 不认这种相对宽度，
 * 必须剥离原始宽高、按 viewBox 补一个显式宽高。这样 loadImage 才能
 * 知道位图尺寸。scale 控制输出分辨率（2 = 2x，导出更清晰）。
 */
export async function rasterizeSvgToPng(svg: string, scale = 2): Promise<string> {
  const sized = normalizeSvgSize(svg);
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(sized, "utf8").toString("base64")}`;
  const img = await loadImage(dataUrl);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas: Canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // 深色底：先铺一层背景，避免透明 PNG 在白色页面上出现白边。
  const background = (sized.match(/style="[^"]*background-color:\s*([^;"]+)/)?.[1] ?? "#ffffff").trim();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

/**
 * 把 mermaid 的 svg 改造成 canvas 能加载的形态：
 * 去掉 `width="100%"` / `height="..."`，按 viewBox 补显式像素宽高。
 */
function normalizeSvgSize(svg: string): string {
  const viewBox = svg.match(/viewBox="([^"]+)"/);
  if (!viewBox) return svg;
  const parts = viewBox[1].split(/\s+/).map(Number);
  if (parts.length !== 4 || !Number.isFinite(parts[2]) || !Number.isFinite(parts[3])) return svg;
  const width = Math.max(1, Math.round(parts[2]));
  const height = Math.max(1, Math.round(parts[3]));
  // 只在开标签上动手：剥离原宽高，补显式值。
  return svg.replace(/<svg([^>]*?)>/i, (whole, attrs: string) => {
    const cleaned = attrs
      .replace(/\swidth="[^"]*"/g, "")
      .replace(/\sheight="[^"]*"/g, "");
    return `<svg${cleaned} width="${width}" height="${height}">`;
  });
}

/**
 * Mermaid 源码 → PNG dataURL 一步到位。
 *
 * 失败时抛错，由调用方（renderCodeBlock 的上层预处理）决定怎么兜底。
 */
export async function renderMermaidToPng(source: string, theme?: Partial<MermaidTheme>): Promise<string> {
  const svg = await renderMermaidToSvg(source, theme);
  return rasterizeSvgToPng(svg);
}
