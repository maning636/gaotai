import { z } from "zod";
import { chartSpecSchema, type ChartKind } from "./chart-spec";
import { insertMarkdownAt } from "./editor-insert";

/**
 * 「全文自动配图」的计划层。
 *
 * 职责是两件事：
 * 1. 把模型给出的原始计划**校验 + 硬过滤**成一份能直接执行的清单；
 *    模型可能编数字、把段落号写越界、一口气列十几张——这里一层层拦。
 * 2. 把计划落回正文：按「第 N 个非空段之后」定位插入，不把图全塞在末尾。
 *
 * 硬过滤不依赖模型听话（规则见 resources/prompts/illustration-plan.md）：
 * - 正文里没有数字 → 丢掉 bar / waffle / kpi（它们必须有真数字）；
 * - afterParagraph 越界 → 夹到合法范围；
 * - 超过篇幅张数上限 → 截断；
 * - 同一位置最多一张；
 * - data 校验失败或类型与数据不匹配 → 整条丢弃。
 *
 * 被丢弃的条目一律写进 warnings，不静默吞掉。
 */

/** 计划里的一条，返回给界面渲染。 */
export type IllustrationPlanItem = {
  id: string;
  kind: ChartKind;
  title: string;
  /** 插在第 N 个非空段之后（1 起）。 */
  afterParagraph: number;
  /** 那一整段的前 40 字，界面显示「插在第 N 段之后：…」。 */
  anchorText: string;
  /** 这张图的数据（完整 ChartSpec，可直接喂渲染器）。 */
  data: unknown;
  /** 一句话说清这张图替读者省了什么力气。 */
  rationale: string;
};

/** 模型原始输出的单条。 */
const modelItemSchema = z.object({
  kind: z.enum(["bar", "waffle", "timeline", "compare", "steps", "kpi"]),
  title: z.string().trim().min(1).max(60),
  afterParagraph: z.number().int().positive(),
  rationale: z.string().trim().min(1).max(200),
  data: z.unknown(),
});

/** 模型整体输出：一个 { plan: [...] } 对象。 */
const modelPlanSchema = z.object({
  plan: z.array(modelItemSchema).max(20),
});

/** 需要真数字的三类图：文章里没数字就不许用。 */
const NUMERIC_KINDS = new Set<ChartKind>(["bar", "waffle", "kpi"]);

/** 需要结构 / 逻辑关系的三类图，不依赖数字。 */
const STRUCTURAL_KINDS = new Set<ChartKind>(["timeline", "compare", "steps"]);

/** 正文里有没有数字（阿拉伯数字）。bar/waffle/kpi 的数据只能从这里来。 */
export function articleHasNumbers(text: string): boolean {
  return /\d/.test(text);
}

/**
 * 按篇幅给张数上限。
 *
 * 规则：≤1500 字最多 1 张；1500–3000 字最多 2 张；>3000 字最多 3 张。
 * 「宁少勿多」——篇幅不够就少配，不硬凑。
 */
export function maxChartsFor(articleLength: number): number {
  if (articleLength <= 1500) return 1;
  if (articleLength <= 3000) return 2;
  return 3;
}

/** 去空白后的字数（「字」按非空白字符算，标点也算）。 */
export function articleCharCount(text: string): number {
  return text.replace(/\s/g, "").length;
}

/** 把正文按空行切成非空段落（保留原始内容，只去掉整段空白的块）。 */
export function splitParagraphs(text: string): string[] {
  return paragraphRuns(text).map(run => run.text);
}

/**
 * 段落切分 + 精确字符偏移。
 *
 * 与 `splitParagraphs` 用同一条规则（空行分段），但额外给出每段在原文里的
 * [start, end) 下标，供按段落定位插入用。处理 CRLF：行尾的 \r 被并入分隔符，
 * 段落正文不含行尾符号。
 */
function paragraphRuns(text: string): { text: string; start: number; end: number }[] {
  const runs: { text: string; start: number; end: number }[] = [];
  // 一个段落 = 连续若干非空行；段落之间由空行隔开。
  // 这里按「行」扫描：`\n` 是唯一行界，`\r` 只出现在行尾并被并入边界。
  const lines = text.split(/\n/);
  let buffer: string[] = [];
  let start = 0;
  let cursor = 0; // 当前行在原文里的起点
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed) {
      if (!buffer.length) start = cursor;
      buffer.push(trimmed);
    } else if (buffer.length) {
      runs.push({ text: buffer.join("\n"), start, end: cursor });
      buffer = [];
    }
    cursor += raw.length + 1; // +1 换行符
  }
  if (buffer.length) {
    runs.push({ text: buffer.join("\n"), start, end: cursor });
  }
  return runs;
}

/** 第 n 个非空段的前 40 字（用于界面提示）。 */
export function paragraphAnchorText(text: string, n: number): string {
  const paragraphs = splitParagraphs(text);
  const para = paragraphs[n - 1];
  if (!para) return "";
  return Array.from(para).slice(0, 40).join("");
}

/**
 * 把一段 Markdown 插到「第 n 个非空段之后」。
 *
 * 返回 ok=false 且 reason 有值时，说明对应段落找不到，已退到末尾插入——
 * 调用方把它计入失败并附原因。
 */
export function insertAfterParagraph(
  content: string,
  afterParagraph: number,
  snippet: string,
): { content: string; ok: boolean; reason?: string } {
  const paragraphs = splitParagraphs(content);
  const count = paragraphs.length;
  if (count === 0) {
    // 正文本来就是空的：只能落在末尾。
    return { content: snippet.trim(), ok: false, reason: "正文是空的，无法定位段落。" };
  }
  if (afterParagraph < 1 || afterParagraph > count) {
    // 找不到对应段落：退到末尾插入，并如实报告失败原因。
    const { content: next } = insertMarkdownAt(content, null, snippet);
    return { content: next, ok: false, reason: `第 ${afterParagraph} 段不存在（全文共 ${count} 段），已插入到末尾。` };
  }

  // 定位到第 n 段之后：即第 n+1 段（若有）的起点，否则正文末尾。
  // runs[i] 是第 i+1 段；插在第 n 段之后 = 插在「第 n+1 段的开头」。
  const runs = paragraphRuns(content);
  let offset = content.length;
  if (afterParagraph < runs.length) {
    const nextRun = runs[afterParagraph]; // 第 afterParagraph+1 段
    if (nextRun) offset = nextRun.start;
  }
  const { content: next } = insertMarkdownAt(content, offset, snippet);
  return { content: next, ok: true };
}

/**
 * 第 n 个非空段之后、应插入内容的字符偏移。
 *
 * 供「一次插多张图」用：先对原文取好各图偏移，再按偏移从大到小依次插入，
 * 这样靠后的插入不会挪动靠前的位置。
 */
export function paragraphInsertOffset(content: string, afterParagraph: number): number {
  const runs = paragraphRuns(content);
  if (afterParagraph < 1 || afterParagraph > runs.length) return content.length;
  if (afterParagraph < runs.length) return runs[afterParagraph].start;
  return content.length;
}

/**
 * 把模型原始输出清洗成可执行计划。
 *
 * 返回的每一项都保证：
 * - data 能通过 chartSpecSchema，且 data.kind 与条目 kind 一致；
 * - afterParagraph 在 [1, 段落数] 内；
 * - 同位置最多一张；
 * - 总张数不超过 maxChartsFor(articleLength)。
 */
export function sanitizePlan(
  raw: unknown,
  article: string,
): { plan: IllustrationPlanItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const paragraphs = splitParagraphs(article);
  const paraCount = paragraphs.length;
  const hasNumbers = articleHasNumbers(article);
  const limit = maxChartsFor(articleCharCount(article));

  const parsed = modelPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      plan: [],
      warnings: [`模型返回的计划格式不对（${firstIssue(parsed.error)}），已整份丢弃。`],
    };
  }

  const cleaned: IllustrationPlanItem[] = [];
  const usedPositions = new Set<number>();
  let idSeq = 0;

  for (const item of parsed.data.plan) {
    // 1) data 校验 + 类型一致。
    const dataParsed = chartSpecSchema.safeParse(item.data);
    if (!dataParsed.success) {
      warnings.push(`条目「${item.title || "未命名"}」的 data 校验失败（${firstIssue(dataParsed.error)}），已丢弃。`);
      continue;
    }
    if (dataParsed.data.kind !== item.kind) {
      warnings.push(`条目「${item.title}」声明的类型（${item.kind}）与数据（${dataParsed.data.kind}）不一致，已丢弃。`);
      continue;
    }

    // 2) 没有数字的正文不许用需要真数字的三类图。
    if (NUMERIC_KINDS.has(item.kind) && !hasNumbers) {
      warnings.push(`条目「${item.title}」用了 ${item.kind}，但正文里没有数字，已丢弃。`);
      continue;
    }
    // 3) 结构类图也要求正文够长（至少两段才谈得上「结构」）。
    if (STRUCTURAL_KINDS.has(item.kind) && paraCount < 2) {
      warnings.push(`条目「${item.title}」用了 ${item.kind}，但正文段落太少，已丢弃。`);
      continue;
    }

    // 4) afterParagraph 越界 → 夹到合法范围。
    let paragraph = item.afterParagraph;
    const clamped = Math.min(Math.max(1, paragraph), Math.max(1, paraCount));
    if (clamped !== paragraph) {
      warnings.push(`条目「${item.title}」的段落号（${paragraph}）越界，已夹到第 ${clamped} 段。`);
      paragraph = clamped;
    }

    // 5) 同一位置最多一张。
    if (usedPositions.has(paragraph)) {
      warnings.push(`条目「${item.title}」与已选条目撞在同一位置（第 ${paragraph} 段后），已丢弃。`);
      continue;
    }

    cleaned.push({
      id: `plan_${++idSeq}`,
      kind: dataParsed.data.kind,
      title: dataParsed.data.title,
      afterParagraph: paragraph,
      anchorText: paragraphAnchorText(article, paragraph),
      data: dataParsed.data,
      rationale: item.rationale,
    });
    usedPositions.add(paragraph);
  }

  // 6) 超过张数上限 → 截断。
  if (cleaned.length > limit) {
    const dropped = cleaned.slice(limit);
    warnings.push(`计划共 ${cleaned.length} 张，超出篇幅上限（${limit} 张），已截断后 ${limit} 张。`);
    for (const item of dropped) {
      warnings.push(`条目「${item.title}」因超出张数上限被截断。`);
    }
    return { plan: cleaned.slice(0, limit), warnings };
  }

  return { plan: cleaned, warnings };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".")} ${issue.message}`.trim() : "格式错误";
}
