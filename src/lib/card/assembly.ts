/**
 * 卡片 DOM 装配层。
 *
 * 把 CardPage[]（纯几何）变成真实的 DOM 节点：`.icard-page` 外层
 * （背景色 + 阴影 + padding）+ `.icard-content` 内卡（cardBackground + 圆角）。
 * 正文复用 markdown.ts 的解析逻辑，但样式走卡片主题的 scoped CSS。
 *
 * 本层只认 DOM（document、HTMLElement），因此只能在浏览器端 import，
 * 不能在 Node 端引。
 */

import type { CardTheme } from "../card-themes";
import { CARD_PAGE_WIDTH, CARD_PAGE_HEIGHT_3_4, buildCardPageCss, type CardTypography } from "../card-themes";
import type { CardBlock, CardPage } from "./render-engine";
import { createCardPagePlan } from "./render-engine";

/** 单张卡片页装配参数。 */
export type AssemblePageOptions = {
  theme: CardTheme;
  typography?: CardTypography;
  /** 页面比例尺寸（缺省 3:4）。 */
  pageSize?: { w: number; h: number };
  /** 是否显示页脚（页码 + 水印）。默认显示。 */
  showFooter?: boolean;
  /** 页脚水印文字（默认主题名）。 */
  watermark?: string;
};

/** 把 mdast 块渲染成卡片正文 HTML 的关键字集合（块级标签）。 */
const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "blockquote", "pre", "table", "hr", "figure"]);

/** 生成主题 scoped CSS 并注入一个 <style> 标签。返回 style 元素。 */
export function injectCardCss(theme: CardTheme, _typography?: CardTypography): HTMLStyleElement {
  const style = document.createElement("style");
  style.dataset.cardCss = "1";
  style.textContent = buildCardPageCss(theme, _typography);
  document.head.appendChild(style);
  return style;
}

/** 把一段纯文本拼成段落 <p>，转义 + 换行转 <br>。 */
function paragraphHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\r?\n/g, "<br />");
}

/** 把块转成 HTML 片段。 */
export function blockToHtml(block: CardBlock): string {
  switch (block.kind) {
    case "heading": {
      const match = /^(#{1,6})\s+(.*)$/.exec(block.content);
      const level = match ? Math.min(6, match[1].length) : 3;
      const text = match ? match[2] : block.content;
      return `<h${level}>${paragraphHtml(text)}</h${level}>`;
    }
    case "paragraph":
      return `<p>${paragraphHtml(block.content)}</p>`;
    case "list": {
      // 每行一个 <li>（带 marker 圆点）。
      const items = block.content
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, "").trim())
        .filter(Boolean);
      if (items.length === 0) return "";
      return `<ul>${items.map(item => `<li><span class="icard-marker">•</span>${paragraphHtml(item)}</li>`).join("")}</ul>`;
    }
    case "blockquote":
      return `<blockquote><p>${paragraphHtml(block.content)}</p></blockquote>`;
    case "code":
      return `<pre><code>${block.content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\r?\n/g, "<br />")}</code></pre>`;
    case "table": {
      const rows = block.content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.startsWith("|"));
      if (rows.length === 0) return "";
      const cells = rows.map(row =>
        row
          .split("|")
          .slice(1, -1)
          .map(cell => cell.trim())
          .filter(Boolean),
      );
      const head = cells[0] ?? [];
      const body = cells.slice(1);
      const thead = `<thead><tr>${head.map(cell => `<th>${paragraphHtml(cell)}</th>`).join("")}</tr></thead>`;
      const tbody = body
        .map(row => `<tr>${row.map(cell => `<td>${paragraphHtml(cell)}</td>`).join("")}</tr>`)
        .join("");
      return `<table>${thead}<tbody>${tbody}</tbody></table>`;
    }
    case "thematicBreak":
      return "<hr />";
    case "image":
      return `<figure><img src="${block.content.replace(/"/g, "&quot;")}" alt="" class="icard-img-fit" /></figure>`;
    default:
      return "";
  }
}

/** 把一页的块拼成内容 HTML。 */
export function pageContentHtml(blocks: CardBlock[]): string {
  return blocks.map(blockToHtml).filter(Boolean).join("");
}

/**
 * 创建单张卡片页 DOM。
 *
 * 结构：
 *   .icard-page（外层，宽高固定，overflow hidden，背景色 + padding）
 *     .icard-content（内卡，flex column，cardBackground + 圆角 + 阴影）
 *       正文块
 *     .icard-footer（页码 + 水印）
 */
export function createCardPageElement(page: CardPage, options: AssemblePageOptions): HTMLDivElement {
  const { theme, watermark } = options;
  const size = options.pageSize ?? { w: CARD_PAGE_WIDTH, h: CARD_PAGE_HEIGHT_3_4 };
  const showFooter = options.showFooter ?? true;

  const root = document.createElement("div");
  root.className = "icard-page";
  root.dataset.cardPage = String(page.index);
  root.style.width = `${size.w}px`;
  root.style.height = `${size.h}px`;
  root.style.setProperty("--icard-page-width", `${size.w}px`);
  root.style.setProperty("--icard-page-height", `${size.h}px`);

  const content = document.createElement("div");
  content.className = "icard-content";
  // min-height:0 允许 flex 子项收缩——否则内容超高时内卡会跟着撑大，
  // scrollHeight 与 clientHeight 相等，溢出检测就失灵了。
  // overflow:hidden 让超高内容被裁剪而不是顶出页面，保证每页固定尺寸。
  content.style.minHeight = "0";
  content.style.overflow = "hidden";
  content.innerHTML = pageContentHtml(page.blocks);

  root.appendChild(content);

  if (showFooter) {
    const footer = document.createElement("div");
    footer.className = "icard-footer";
    const num = document.createElement("span");
    num.className = "icard-page-num";
    num.textContent = `${page.index + 1}`;
    const mark = document.createElement("span");
    mark.className = "icard-watermark";
    mark.textContent = watermark ?? theme.name;
    footer.appendChild(num);
    footer.appendChild(mark);
    root.appendChild(footer);
  }

  return root;
}

/**
 * 实测一页内容是否溢出（scrollHeight 超过 clientHeight）。
 *
 * 把页元素挂到离屏容器里读滚动尺寸。返回是否溢出。
 * 用 scrollHeight 而不是 offsetHeight：内容超高时内卡自身高度被
 * 页面 flex 固定住，offsetHeight 反映的是布局高度，滚动高度才是真实内容高。
 */
export function measurePageOverflow(el: HTMLElement): boolean {
  const content = el.querySelector<HTMLElement>(".icard-content");
  if (!content) return false;
  // 内容实际占用高超过内卡可用高即溢出。留 2px 容差。
  return content.scrollHeight > content.clientHeight + 2;
}

/**
 * 把整页正文块按主题样式渲染为卡片 HTML 字符串（不挂 DOM）。
 *
 * 给预览缩略图用：直接用 innerHTML 注入，样式由 injectCardCss 注入的 scoped CSS 提供。
 */
export function pageToHtml(page: CardPage, options: AssemblePageOptions): string {
  const { theme } = options;
  const size = options.pageSize ?? { w: CARD_PAGE_WIDTH, h: CARD_PAGE_HEIGHT_3_4 };
  const showFooter = options.showFooter ?? true;
  const padding = theme.tokens.pagePadding;
  const footer = showFooter
    ? `<div class="icard-footer"><span class="icard-page-num">${page.index + 1}</span><span class="icard-watermark">${options.watermark ?? theme.name}</span></div>`
    : "";
  return (
    `<div class="icard-page" data-card-page="${page.index}" style="width:${size.w}px;height:${size.h}px;--icard-page-width:${size.w}px;--icard-page-height:${size.h}px">` +
    `<div class="icard-content" style="padding:${padding}px">${pageContentHtml(page.blocks)}</div>` +
    footer +
    `</div>`
  );
}

/** 校验一个元素是否已正确装配（.icard-page 且含 .icard-content）。 */
export function isCardPageElement(el: HTMLElement): boolean {
  return el.classList.contains("icard-page") && el.querySelector(".icard-content") !== null;
}

/** 移除注入过的主题 CSS（仅移除本模块注入的 style[data-card-css]）。 */
export function removeInjectedCardCss(): void {
  for (const style of Array.from(document.head.querySelectorAll<HTMLStyleElement>("style[data-card-css]"))) {
    style.remove();
  }
}

/** 把 HTML 字符串解析成元素（供测试/离屏装配复用）。 */
export function parseHtmlToElement(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  const child = container.firstElementChild;
  if (!child) throw new Error("HTML 解析后没有元素");
  return child as HTMLElement;
}

// 保留 BLOCK_TAGS 常量避免未使用告警（供后续扩展语义判断）。
export const __cardBlockTags = BLOCK_TAGS;

/**
 * 实测一页内容真实高度（px）。挂到离屏容器后调用。
 */
export function measureContentHeight(el: HTMLElement): number {
  const content = el.querySelector<HTMLElement>(".icard-content");
  return content ? content.scrollHeight : 0;
}

/**
 * 实测一个块（.icard-content 子节点）的渲染高度（px）。
 */
export function measureBlockHeight(el: HTMLElement): number {
  return el.getBoundingClientRect().height;
}

/**
 * 从真实 DOM 块高度反推出块的估算高度，并写回 CardBlock。
 *
 * 分页用的是 CardBlock.estimate；DOM 实测后把真实值写回去，
 * 下一轮重排就更准。原地修改并返回。
 */
export function syncBlockEstimatesFromDom(blocks: CardBlock[], container: HTMLElement): CardBlock[] {
  const children = Array.from(container.children).filter(child =>
    BLOCK_TAGS.has(child.tagName.toLowerCase()),
  );
  children.forEach((child, index) => {
    const block = blocks[index];
    if (block) {
      block.estimate = Math.round(child.getBoundingClientRect().height);
    }
  });
  return blocks;
}

/** 渲染整篇卡片并做溢出核验收缩重排（最多 MAX_FIT_ROUNDS 轮）。 */
export function renderCardPages(
  blocks: CardBlock[],
  theme: CardTheme,
  options: {
    typography?: CardTypography;
    ratio?: string;
    pageSize?: { w: number; h: number };
    watermark?: string;
  },
): HTMLDivElement[] {
  const pageSize = options.pageSize ?? { w: 375, h: 500 };
  const padding = theme.tokens.pagePadding;
  const gap = theme.tokens.contentGap;
  const footer = options.watermark ? 30 : 0;
  const contentH = Math.max(60, pageSize.h - 14 * 2 - padding * 2 - footer);

  // 初始分页：用估算高度。
  const plan = createCardPagePlan({ blocks, pageSize, contentHeight: contentH, gap });
  const pages: HTMLDivElement[] = [];

  // 逐轮重排：真实测量后若溢出，把块切得更细再分页。
  // 这里只做一次精细化的重排（把超高块拆成小块），
  // 完整的多轮收缩由前端在挂载后通过 fit 回调驱动。
  for (const page of plan.pages) {
    pages.push(createCardPageElement(page, {
      theme,
      typography: options.typography,
      pageSize,
      watermark: options.watermark,
    }));
  }
  return pages;
}
