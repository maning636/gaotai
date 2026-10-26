import type { EditRow } from "./db";
import {
  countEdits,
  getStyleProfile as readStyleProfile,
  listEdits,
  saveStyleProfile,
} from "./repo";

/**
 * 风格记忆。
 *
 * 风格画像的唯一证据来源是**用户的手改记录**：AI 写了什么不算数，
 * 人把它改成什么样才算数。每一次人工修改都存着「改前原文」和「改后原文」，
 * 这里从这些差异里反推作者的写作习惯。
 *
 * 刻意做成纯本地启发式统计，不调用大模型：
 * - 画像是长期资产，模型会变，统计口径不会；
 * - 作者的编辑记录是隐私，不该为了总结它而外发。
 */

/** 少于这个条数就生成不了有意义的画像。 */
export const MIN_EDITS_FOR_PROFILE = 6;

export type StyleMetrics = {
  avgSentenceLength: number;
  /** 句长不超过 20 字的句子占比，0-1。 */
  shortSentenceRatio: number;
  /** 含问号的句子占比，0-1。 */
  questionRatio: number;
  /** 含感叹号的句子占比，0-1。 */
  exclamationRatio: number;
  /** 平均段落长度（字符）。 */
  avgParagraphLength: number;
  preferredPunctuation: string[];
  commonOpenings: string[];
  commonClosings: string[];
};

export type StyleAnalysis = {
  /** 给模型看的 markdown 画像正文。 */
  profile: string;
  editCount: number;
  metrics: StyleMetrics;
};

const SENTENCE_SPLIT = /(?<=[。！？；!?;])/;
const PUNCTUATION = /[，。、；：！？“”‘’（）《》〈〉…—·\s,.!?;:'"()[\]{}<>/\\|`~@#$%^&*+=]/g;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map(part => part.trim())
    .filter(Boolean);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n/)
    .map(part => part.trim())
    .filter(Boolean);
}

/** 去掉全部标点与空白，只留字词——用来判断两句是不是同一句话。 */
function normalize(text: string): string {
  return text.replace(PUNCTUATION, "").toLowerCase();
}

/**
 * 最长公共子序列（按句级）。
 *
 * 用来把「改后文本」拆成两部分：和改前一样的（LCS 里的），以及作者新写的（LCS 外的）。
 * 作者新写的那些句子才是风格样本。
 */
function lcsPairs(a: string[], b: string[]): { pairs: [number, number][] } {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { pairs };
}

function ratio(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 1000 : 0;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

function topRepeated(fragments: string[], minCount: number, limit: number): string[] {
  const counter = new Map<string, number>();
  for (const fragment of fragments) {
    if (!fragment) continue;
    counter.set(fragment, (counter.get(fragment) ?? 0) + 1);
  }
  return [...counter.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([fragment]) => fragment);
}

/** 找出作者真正动过笔的句子：改后文本里，改前没有的句子。 */
function authorSamples(before: string, after: string): string[] {
  const beforeSentences = splitSentences(before);
  const afterSentences = splitSentences(after);
  if (!beforeSentences.length) return afterSentences;

  const { pairs } = lcsPairs(beforeSentences.map(normalize), afterSentences.map(normalize));
  const matchedAfter = new Set(pairs.map(([, j]) => j));
  const samples = afterSentences.filter((_, index) => !matchedAfter.has(index));
  // 全是替换时（新句子数和旧句子数相同）LCS 会失配，此时退化为用全部改后句子。
  return samples.length ? samples : afterSentences;
}

function buildProfile(metrics: StyleMetrics, sampleCount: number): string {
  if (sampleCount === 0) {
    return [
      "## 作者风格",
      "",
      "目前还没有足够的人工修改记录，暂时提炼不出稳定的写作习惯。",
      "先按通用写作要求来，等修改次数攒够后本节会自动更新。",
    ].join("\n");
  }

  const lines: string[] = ["## 作者风格", ""];

  const rhythm =
    metrics.shortSentenceRatio >= 0.4
      ? "偏好短句，一句话讲完一件事，句号落得勤"
      : metrics.shortSentenceRatio <= 0.15
        ? "句子偏长，允许一句里用分号或逗号串起两个相关意思"
        : "长短句交替，长句讲道理、短句下判断";
  lines.push(`- **句子节奏**：${rhythm}，平均每句约 ${metrics.avgSentenceLength} 字。`);

  lines.push(
    `- **段落长度**：平均每段约 ${metrics.avgParagraphLength} 字。写完一段如果明显更长，拆开。`,
  );

  if (metrics.preferredPunctuation.length) {
    // 每个标点单独加引号：直接罗列会和句末的句号连在一起，读起来像叠字。
    const marks = metrics.preferredPunctuation.map(char => `「${char}」`).join("");
    lines.push(`- **标点习惯**：最爱用${marks}。`);
  }

  if (metrics.commonOpenings.length) {
    lines.push(`- **开头方式**：常用「${metrics.commonOpenings.join("」「")}」这类起手。`);
  }

  if (metrics.commonClosings.length) {
    lines.push(`- **收尾方式**：常用「${metrics.commonClosings.join("」「")}」这类收束。`);
  }

  const questionText =
    metrics.questionRatio >= 0.15
      ? "喜欢用反问推进"
      : metrics.questionRatio <= 0.02
        ? "几乎不用问句"
        : "偶尔用问句";
  const exclamationText =
    metrics.exclamationRatio >= 0.1 ? "感叹句偏多" : metrics.exclamationRatio <= 0.01 ? "不用感叹号" : "感叹句很少";
  lines.push(`- **语气强度**：${questionText}，${exclamationText}。`);

  lines.push(
    "",
    `以上倾向来自 ${sampleCount} 处作者亲笔改写的句子，是统计倾向而不是硬性规定；与本稿的可读性冲突时以可读性为准。`,
  );

  return lines.join("\n");
}

/** 从一批修改记录里分析出风格。空数组也能安全调用。 */
export function analyzeEdits(edits: EditRow[]): StyleAnalysis {
  const samples: string[] = [];
  for (const edit of edits) {
    samples.push(...authorSamples(edit.before_text ?? "", edit.after_text ?? ""));
  }

  const allAfter = edits.map(edit => edit.after_text ?? "").join("\n");
  // 样本太少时统计全部改后文本，避免画像因为一两处改动而失真。
  const basis = samples.length >= 3 ? samples : splitSentences(allAfter);
  const sentences = basis.filter(Boolean);

  const lengths = sentences.map(sentence => sentence.length);
  const shortCount = lengths.filter(length => length <= 20).length;
  const questionCount = sentences.filter(sentence => /[？?]/.test(sentence)).length;
  const exclamationCount = sentences.filter(sentence => /[！!]/.test(sentence)).length;

  const paragraphs = splitParagraphs(allAfter);
  const punctuationCounter = new Map<string, number>();
  for (const sentence of sentences) {
    for (const char of sentence) {
      if (!/[，。、；：！？“”‘’（）《》…—]/.test(char)) continue;
      punctuationCounter.set(char, (punctuationCounter.get(char) ?? 0) + 1);
    }
  }
  const preferredPunctuation = [...punctuationCounter.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([char]) => char);

  // 起手与收尾只从够长的句子里取：太短的句子截出来首尾是同一段，
  // 记成「常用『作者写得很短。』这类起手」没有意义。
  const longEnough = sentences.filter(sentence => sentence.length >= 12);
  const openings = longEnough.map(sentence => sentence.slice(0, 6));
  const closings = longEnough.map(sentence => sentence.slice(-6));

  const metrics: StyleMetrics = {
    avgSentenceLength: average(lengths),
    shortSentenceRatio: ratio(shortCount, sentences.length),
    questionRatio: ratio(questionCount, sentences.length),
    exclamationRatio: ratio(exclamationCount, sentences.length),
    avgParagraphLength: average(paragraphs.map(paragraph => paragraph.length)),
    preferredPunctuation,
    commonOpenings: topRepeated(openings, 2, 5),
    commonClosings: topRepeated(closings, 2, 5),
  };

  return {
    profile: buildProfile(metrics, samples.length),
    editCount: edits.length,
    metrics,
  };
}

/**
 * 重新生成某个专题的风格画像。
 *
 * 样本不足时返回 null 且不写库——半成品的画像会误导模型，不如没有。
 */
export async function refreshStyleProfile(topicId: string): Promise<StyleAnalysis | null> {
  const edits = listEdits({ topicId });
  if (edits.length < MIN_EDITS_FOR_PROFILE) return null;
  const analysis = analyzeEdits(edits);
  saveStyleProfile(topicId, analysis.profile);
  return analysis;
}

/** 读取已保存的画像。没有就是空串。 */
export async function getStyleProfile(topicId: string): Promise<string> {
  return readStyleProfile(topicId)?.profile ?? "";
}

/** 当前某个专题攒了多少次人工修改。 */
export async function getEditCount(topicId: string): Promise<number> {
  return countEdits(topicId);
}
