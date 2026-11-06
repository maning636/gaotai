import { markdownToWechatHtml, type WechatRenderOptions } from "../markdown";
import { renderMath } from "./math";
import { renderMermaidToPng, type MermaidTheme } from "./mermaid";

/**
 * 异步版 markdown → 公众号 HTML。
 *
 * 只在 Node 端用（API 路由）：这里才允许碰 mathjax-full 和 mermaid。
 * 客户端组件走同步的 `markdownToWechatHtml`，那边不处理公式与图表——
 * 那两个库太重，不能进浏览器 bundle。
 *
 * 流程：先把 Markdown 里的
 *   1. 行内 `$...$` / 块级 `$$...$$` 公式 → 自包含 SVG（mathjax），
 *   2. ```mermaid``` 代码块 → PNG dataURL（mermaid + canvas），
 * 各自替换成占位符，再把占位符交给同步渲染器；同步渲染器把占位符当普通文本
 * 走一遍（转义/排版都安全），最后把 SVG/PNG 填回占位符位置。
 *
 * 占位符用私有区字符 `\uE000` 包裹，几乎不可能跟正文撞车；
 * escapeHtml 不会动它，填回时再删掉。
 */

// 占位符形状：\uE000 MATH <序号> \uE000 / \uE000 MM <序号> \uE000。
const PLACEHOLDER_MATH = "\uE000MATH";
const PLACEHOLDER_MM = "\uE000MM";

/** 提取到的公式：占位符 + 渲染好的 SVG + 是否块级。 */
type MathSlot = { placeholder: string; svg: string; display: boolean };
/** 提取到的 mermaid 图：占位符 + 源码体。 */
type MermaidSlot = { placeholder: string; source: string };

/**
 * 从 Markdown 原文里扫描公式与 mermaid 代码块，渲染成 SVG/PNG。
 *
 * 扫描必须绕开代码块（``` 围栏）与行内代码（`...`）——里面的 `$` 是
 * 代码内容，不是公式。所以用一个带四分支的正则一次扫完：
 * 围栏代码 / 行内代码 原样保留，公式与 mermaid 替换成占位符。
 */
function extractSlots(
  markdown: string,
): { replaced: string; math: MathSlot[]; mermaid: MermaidSlot[] } {
  const math: MathSlot[] = [];
  const mermaid: MermaidSlot[] = [];
  let mathIndex = 0;
  let mmIndex = 0;

  // 分支顺序有讲究：先认围栏代码，再认行内代码，最后认公式——
  // 这样 ``` 里的 $ 与 ` 里的 $ 都不会被当公式吃掉。
  // m 标志：围栏分支的 ^/ $ 按行匹配（关闭围栏在行首）。
  const tokenRe =
    /(```[^\n]*\n[\s\S]*?^```[ \t]*$)|(`[^`\n]+`)|(\$\$[\s\S]+?\$\$)|(\$(?=\S)[^$\n]*?\S\$)/gm;

  const replaced = markdown.replace(tokenRe, (whole, fence, inline, display, inlineMath) => {
    // 围栏代码块：mermaid 渲染成图，其余原样保留。
    if (fence) {
      const langMatch = fence.match(/^```([^\n]*)/);
      const lang = (langMatch?.[1] ?? "").trim().toLowerCase();
      if (lang === "mermaid") {
        const body = fence
          .replace(/^```[^\n]*\n/, "")
          .replace(/\n?```[ \t]*$/, "");
        const placeholder = `${PLACEHOLDER_MM}${mmIndex++}\uE000`;
        mermaid.push({ placeholder, source: body.trim() });
        return `\n${placeholder}\n`;
      }
      return whole;
    }
    // 行内代码：原样保留，里面的 $ 不是公式。
    if (inline) return whole;
    // 块级公式 $$...$$
    if (display) {
      const formula = display.slice(2, -2).trim();
      const svg = renderMath(formula, true);
      if (!svg) return whole; // 渲染失败就留原文
      const placeholder = `${PLACEHOLDER_MATH}${mathIndex++}\uE000`;
      math.push({ placeholder, svg, display: true });
      return placeholder;
    }
    // 行内公式 $...$
    if (inlineMath) {
      const formula = inlineMath.slice(1, -1).trim();
      const svg = renderMath(formula, false);
      if (!svg) return whole;
      const placeholder = `${PLACEHOLDER_MATH}${mathIndex++}\uE000`;
      math.push({ placeholder, svg, display: false });
      return placeholder;
    }
    return whole;
  });

  return { replaced, math, mermaid };
}

/** 块级公式包一层居中滚动容器，行内公式裸 SVG。 */
function wrapMathSvg(svg: string, display: boolean): string {
  if (!display) return svg;
  return `<section style="text-align: center; margin: 12px 0; overflow-x: auto;">${svg}</section>`;
}

/**
 * 渲染整篇 Markdown 成公众号 HTML，支持 LaTeX 公式与 Mermaid 图表。
 *
 * 公式与图表都是异步（mermaid 渲染 + canvas 栅格化），所以整体是 async。
 * 不含公式/图表的稿子走同步版 `markdownToWechatHtml` 即可，结果一致。
 */
export async function markdownToWechatHtmlAsync(
  markdown: string,
  options: WechatRenderOptions = {},
): Promise<string> {
  const { replaced, math, mermaid } = extractSlots(markdown);

  // mermaid 图逐个渲染（异步）；渲染失败时退回占位文本，不让整篇挂掉。
  const mermaidImages = new Map<string, string>();
  for (const slot of mermaid) {
    try {
      const png = await renderMermaidToPng(slot.source);
      mermaidImages.set(
        slot.placeholder,
        `<img src="${png}" style="max-width: 100%; display: block; margin: 0 auto;" alt="mermaid 图表" />`,
      );
    } catch {
      mermaidImages.set(slot.placeholder, "（mermaid 图表渲染失败）");
    }
  }

  // 同步基座：占位符是普通文本，转义/排版都安全。
  let html = markdownToWechatHtml(replaced, options);

  // 填回公式 SVG。
  for (const slot of math) {
    html = html.split(slot.placeholder).join(wrapMathSvg(slot.svg, slot.display));
  }
  // 填回 mermaid 图。
  for (const [placeholder, img] of mermaidImages) {
    html = html.split(placeholder).join(img);
  }
  return html;
}

export type { MermaidTheme };
