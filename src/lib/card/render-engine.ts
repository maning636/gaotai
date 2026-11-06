/**
 * 卡片渲染引擎（纯逻辑层）。
 *
 * 这一层只做「把 Markdown 块切到多张卡片页里」的几何计算，不碰 DOM。
 * 输入是已经解析好的文档块（block 结构），输出是 `CardPage[]`——
 * 每一页知道该放哪些块、用什么比例、第几页。
 *
 * 布局主循环：measure → plan → assemble → 溢出核验收缩重排（最多 5 轮）。
 * 由于纯函数里没法真实量高，measure 用「估算高度」，
 * 溢出核验交给 DOM 装配层（assembly.ts）在离屏容器里实测后回调 fit 结果，
 * 由 renderAndFit 驱动重排。
 */

import type { CardTheme } from "../card-themes";

/** 竖版比例预设：宽度固定 375px，高度按比例取整。 */
export const RATIO_PRESETS: Record<string, { w: number; h: number }> = {
  "3:4": { w: 375, h: 500 },
  "3:5": { w: 375, h: 625 },
  "9:16": { w: 375, h: 667 },
};

/** 比例列表（顺序即界面展示顺序）。 */
export const RATIO_KEYS: (keyof typeof RATIO_PRESETS)[] = ["3:4", "3:5", "9:16"];

/** 默认比例。 */
export const DEFAULT_RATIO: keyof typeof RATIO_PRESETS = "3:4";

/** 溢出核验收缩重排的最大轮数。 */
export const MAX_FIT_ROUNDS = 5;

/** 文档块类型：卡片只认标题、段落、列表、引用、代码、表格、分隔线、图片。 */
export type CardBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "blockquote"
  | "code"
  | "table"
  | "thematicBreak"
  | "image";

/** 一个可独立分页的文档块。 */
export type CardBlock = {
  kind: CardBlockKind;
  /** 块语义内容（渲染层据此拼 HTML）。 */
  content: string;
  /** 块自身的估算高度（px），供 measure 阶段用。 */
  estimate: number;
  /** 是否允许整块保持在同一页（默认 true；超大代码块允许跨页）。 */
  atomic?: boolean;
};

/** 一页卡片。 */
export type CardPage = {
  index: number;
  width: number;
  height: number;
  blocks: CardBlock[];
  /** 本页块估算高度合计（含块间距），用于进度与调试。 */
  estimatedHeight: number;
};

/** 分页输入。 */
export type CardPagePlanInput = {
  blocks: CardBlock[];
  pageSize: { w: number; h: number };
  /** 内卡可用内容高度（页高 - 页面留白 - 内卡留白 - 页脚），估算用。 */
  contentHeight: number;
  /** 块之间的间距（px）。 */
  gap: number;
};

/** 分页结果。 */
export type CardPagePlanResult = {
  pages: CardPage[];
  /** 是否所有块都装进去了（没有因单块超高而被丢弃）。 */
  complete: boolean;
};

/** 估算每行文本高度。按中英混合大致 1.0 字符宽算行数。 */
function estimateLines(text: string, charsPerLine: number): number {
  if (!text) return 0;
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    const width = Math.ceil(line.length / Math.max(1, charsPerLine));
    lines += Math.max(1, width);
  }
  return lines;
}

/**
 * 估算一个块的渲染高度。
 *
 * 这是 measure 阶段的近似值；真实高度由 DOM 装配层实测后通过 fit 回调修正。
 * 这里按「内卡宽度 375 - 2*28 ≈ 319px，字号 14px」的常见参数估。
 */
export function estimateBlockHeight(block: CardBlock, contentWidth = 319): number {
  switch (block.kind) {
    case "heading": {
      const level = /^#{1,6}/.exec(block.content)?.[0].length ?? 1;
      const size = level <= 1 ? 22 : level === 2 ? 19 : level === 3 ? 17 : 15;
      const lines = estimateLines(block.content.replace(/^#{1,6}\s+/, ""), Math.floor(contentWidth / size));
      return lines * size * 1.35 + 12;
    }
    case "paragraph": {
      const lines = estimateLines(block.content, Math.floor(contentWidth / 14));
      return lines * 14 * 1.7 + 4;
    }
    case "list": {
      const lines = estimateLines(block.content, Math.floor(contentWidth / 14));
      return lines * 14 * 1.65 + 6;
    }
    case "blockquote": {
      const lines = estimateLines(block.content, Math.floor((contentWidth - 30) / 13.5));
      return lines * 13.5 * 1.7 + 20;
    }
    case "code": {
      const lines = block.content.split(/\r?\n/).length;
      return lines * 13 * 1.6 + 44;
    }
    case "table": {
      const rows = block.content.split(/\r?\n/).length;
      return Math.max(1, rows) * 30 + 14;
    }
    case "thematicBreak":
      return 16;
    case "image":
      return 200;
    default:
      return 24;
  }
}

/**
 * 把文档块列表切成多页。
 *
 * 贪心装填：按块顺序累积估算高度，超过 contentHeight 就开新页。
 * 单块高度超过整页（无法容纳）时仍单独成页并标记 incomplete，
 * 由上层决定是收缩字号还是允许溢出。
 */
export function createCardPagePlan(input: CardPagePlanInput): CardPagePlanResult {
  const { blocks, pageSize, contentHeight, gap } = input;
  const pages: CardPage[] = [];
  let current: CardBlock[] = [];
  let currentHeight = 0;
  let complete = true;

  const pushPage = () => {
    if (current.length === 0) return;
    pages.push({
      index: pages.length,
      width: pageSize.w,
      height: pageSize.h,
      blocks: current,
      estimatedHeight: Math.round(currentHeight),
    });
    current = [];
    currentHeight = 0;
  };

  for (const block of blocks) {
    const blockH = block.estimate > 0 ? block.estimate : estimateBlockHeight(block);
    const needed = currentHeight === 0 ? blockH : currentHeight + gap + blockH;

    // 单块超高：仍单独一页，但标记不完整。
    if (blockH > contentHeight) {
      pushPage();
      current = [block];
      currentHeight = blockH;
      complete = false;
      pushPage();
      continue;
    }

    if (needed > contentHeight) {
      pushPage();
      current = [block];
      currentHeight = blockH;
    } else {
      current.push(block);
      currentHeight = needed;
    }
  }
  pushPage();

  if (pages.length === 0) {
    // 空文档也至少给一页空卡。
    pages.push({ index: 0, width: pageSize.w, height: pageSize.h, blocks: [], estimatedHeight: 0 });
  }

  return { pages, complete };
}

/**
 * 从纯文本行构造块列表。
 *
 * 简易分块：空行分段，`#` 开头是标题，`-`/`*`/数字开头是列表，
 * `>` 开头是引用，``` 围栏是代码，`---` 是分隔线，`![...]()` 是图片，
 * `|` 开头是表格；其余为段落。
 */
export function buildBlocksFromMarkdown(markdown: string): CardBlock[] {
  const blocks: CardBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let buffer: string[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];

  const flushParagraph = () => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", content: text, estimate: 0, atomic: true });
    buffer = [];
  };

  // 连续列表行累积成一块 list。
  let listBuffer: string[] = [];
  const flushList = () => {
    if (listBuffer.length === 0) return;
    blocks.push({ kind: "list", content: listBuffer.join("\n"), estimate: 0, atomic: true });
    listBuffer = [];
  };

  for (const line of lines) {
    if (inCode) {
      if (/^\s*```/.test(line)) {
        inCode = false;
        blocks.push({
          kind: "code",
          content: codeBuffer.join("\n"),
          estimate: 0,
          atomic: false,
        });
        codeBuffer = [];
      } else {
        codeBuffer.push(line);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      inCode = true;
      continue;
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "thematicBreak", content: "", estimate: 0, atomic: true });
      continue;
    }

    const imageMatch = /^\s*!\[([^\]]*)\]\(([^)\s]+)/.exec(line);
    if (imageMatch) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "image", content: imageMatch[2], estimate: 0, atomic: true });
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "table", content: line, estimate: 0, atomic: true });
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "blockquote", content: line.replace(/^\s*>\s?/, ""), estimate: 0, atomic: true });
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: "heading",
        content: `${headingMatch[1]} ${headingMatch[2].trim()}`,
        estimate: 0,
        atomic: true,
      });
      continue;
    }

    const listMatch = /^\s*([-*+]|\d+\.)\s+/.exec(line);
    if (listMatch) {
      // 列表行累积成 list 块；进入列表前先清掉待定段落。
      flushParagraph();
      listBuffer.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    buffer.push(line);
  }
  flushParagraph();
  flushList();
  if (inCode) {
    blocks.push({ kind: "code", content: codeBuffer.join("\n"), estimate: 0, atomic: false });
  }
  return blocks;
}

/**
 * 估算整篇内容需要的高度（px）。给 UI 判断篇幅用。
 */
export function estimateTotalHeight(blocks: CardBlock[], gap: number, contentWidth = 319): number {
  let total = 0;
  for (const block of blocks) {
    const h = block.estimate > 0 ? block.estimate : estimateBlockHeight(block, contentWidth);
    total += h;
  }
  if (blocks.length > 1) total += gap * (blocks.length - 1);
  return total;
}

/**
 * 计算某比例的页面尺寸。
 */
export function pageSizeForRatio(ratio: string): { w: number; h: number } {
  const preset = RATIO_PRESETS[ratio] ?? RATIO_PRESETS[DEFAULT_RATIO];
  return { w: preset.w, h: preset.h };
}

/**
 * 计算内卡可用内容高度。
 *
 * 页高 - 页面留白(14*2) - 内卡上下留白(pagePadding*2) - 页脚(~28)。
 */
export function availableContentHeight(theme: CardTheme, pageSize: { h: number }): number {
  const padding = theme.tokens.pagePadding;
  const pageOuter = 14 * 2;
  const footer = 30;
  return Math.max(60, pageSize.h - pageOuter - padding * 2 - footer);
}
