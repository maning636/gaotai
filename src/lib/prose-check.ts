/**
 * 成稿体检：查 AI 味。
 *
 * 规则来自 MIT 授权的 human-writing 技能包自带的 check_prose.py
 * （见 resources/skills/human-writing/LICENSE）。原版是 Python 命令行脚本，
 * 桌面客户端不能指望用户机器上装 Python，所以这里做一份原生实现：
 * 规则表、正则与阈值与上游一致，输出从「打印给人看」改成结构化数据，
 * 好让界面和模型都能用。
 *
 * 检查器只报警，不改文——改文是人的事。
 *
 * 两档：
 * - fail：硬禁令，冒号、破折号、翻案句、硬停词、绝对禁用黑话、模型路标；
 * - warn：需要结合语境判断的词，以及「像模型写出来的」形状信号。
 */

import type { ChatMessage, ChatTool } from "./llm";
import { findRepetitions } from "./repetition";

export type ProseLevel = "fail" | "warn";
export type ProseFinding = {
  level: ProseLevel;
  /** 机器可读的类别，便于界面分组与统计。 */
  kind: string;
  /** 给人和模型看的中文说明。 */
  message: string;
  /** 出问题的行号（1 起）。 */
  line?: number;
  /** 出问题的原文片段。 */
  excerpt?: string;
};

export type ProseCheckResult = {
  /** 正文字数（只数汉字）。 */
  hanCount: number;
  /** 各类命中计数。 */
  summary: Record<string, number>;
  findings: ProseFinding[];
  /** 没有硬禁令就是 true。 */
  ok: boolean;
};

/* ------------------------------------------------------------------ */
/* 规则表                                                              */
/* ------------------------------------------------------------------ */

const HARD_STOPS = ["说白了", "说穿了", "先说结论"];

const HARD_JARGON = [
  "赋能",
  "抓手",
  "商业闭环",
  "价值闭环",
  "能力沉淀",
  "拉通",
  "底层逻辑",
  "顶层设计",
  "认知跃迁",
  "价值释放",
  "能力建设",
  "降本增效",
  "内容矩阵",
  "全链路",
  "组合拳",
  "打开想象空间",
  "结构性机会",
  "关键命题",
  "深层逻辑",
  "技术底座",
  "公共底座",
  "技术主权",
  "单点风险",
  "主脊柱",
  "材料锚点",
  "认知增量",
  "迭代闭环",
];

const CONTEXT_JARGON = [
  "沉淀",
  "颗粒度",
  "对齐",
  "协同",
  "链路",
  "生态位",
  "心智",
  "范式",
  "方法论",
  "核心变量",
  "打法",
  "想象空间",
  "闭环",
  "不丢",
];

const LYRIC_WORDS = ["安放", "抵达", "微光", "褶皱", "丰盈", "滚烫", "轻盈", "赤裸", "剥开"];

const ROAD_SIGNS = [
  "更微妙的是",
  "还有一层",
  "只说对了一半",
  "值得注意的是",
  "需要指出的是",
  "从某种意义上说",
];

const FORBIDDEN_PUNCTUATION: Record<string, string> = {
  "：": "中文冒号",
  ":": "英文冒号",
  "—": "破折号",
  "–": "连接号式破折号",
};

const PIVOT_PATTERNS = [
  /(?:并)?不是[^。！？\n]{0,90}而是/,
  /并非[^。！？\n]{0,90}而是/,
  /不在于[^。！？\n]{0,90}而在于/,
  /与其说[^。！？\n]{0,90}(?:不如|毋宁|倒不如)/,
  /[。！？!?]\s*而是/,
  /表面(?:上)?[^。！？\n]{0,90}(?:其实|实际|实则)/,
  /看似[^。！？\n]{0,90}(?:其实|实际|实则)/,
];

const SEMANTIC_PIVOT_PATTERNS = [
  /(?:总|一直|曾|都)?以为[^！？\n]{2,60}?(?:其实|才发现|才明白|才知道|后来才)/,
  /(?:总|都|一直)以为[^！？\n]{2,60}?[。，](?:可|但|其实)/,
  /回头(?:看|一看)?才(?:发现|明白|知道)/,
  /(?:并)?不是[^。！？\n]{1,40}，(?:更|才)?是[^，。！？\n]/,
  /从来(?:都)?(?:不是|与[^。！？，\n]{1,12}无关)/,
  /答案(?:是否定的|恰恰相反)|恰恰相反/,
  /表面(?:上)?[^！？\n]{0,60}。[^！？\n]{0,12}(?:其实|实际|实则)/,
  /看似[^！？\n]{0,60}。[^！？\n]{0,12}(?:其实|实际|实则)/,
  /[^，。！？\n]{1,12}不重要，(?:重要|要紧)的是/,
  /真正[^，。！？\n]{0,16}的(?:，)?是/,
  /不只(?:是)?[^。！？\n]{0,90}(?:还|也)/,
];

const NOMINALIZATION_PATTERNS = [
  /进行(?:了|一次|一场|着)?[^。，！？\n]{0,10}(?:调整|优化|升级|分析|讨论|沟通|梳理|复盘|迭代|探索|尝试|思考|规划|布局)/,
  /实现了?[^。，！？\n]{0,14}的?[^。，！？\n]{0,6}(?:提升|增长|突破|转变|跃升|落地)/,
  /完成了?对[^。，！？\n]{0,16}的/,
  /起到了?[^。，！？\n]{0,12}的?作用/,
  /具有[^。，！？\n]{0,10}(?:意义|价值)/,
];

const CONJUNCTIONS = [
  "因为",
  "所以",
  "但是",
  "然而",
  "同时",
  "此外",
  "而且",
  "并且",
  "因此",
  "不仅",
];

const SOFT_MARKERS = [
  "真正",
  "本质上",
  "更深层次",
  "归根结底",
  "换句话说",
  "不可否认",
  "核心是",
  "关键在于",
  "这意味着",
];

const REPEATED_OPENERS = [
  "其实",
  "不过",
  "当然",
  "所以",
  "但是",
  "后来",
  "当时",
  "很多人",
  "问题是",
  "更重要的是",
  "说到这里",
];

const LEFT_BRANCH_PATTERNS = [
  /(?:^|[。！？]\s*)在[^，。！？\n]{12,70}(?:以后|之后|之前|以前|过程中|情况下|背景下)，/,
  /(?:^|[。！？]\s*)那些[^，。！？\n]{10,60}的[^，。！？\n]{2,30}[，。]/,
  /(?:^|[。！？]\s*)(?:真正|最终|最后)让[^，。！？\n]{8,70}的，是/,
];

const METAPHOR_FIELDS: Record<string, string[]> = {
  温度: ["降温", "升温", "冷却", "余温", "温度最高"],
  生死战争: ["杀死", "死因", "枪响", "开火", "战场", "引爆", "弹药"],
  建筑灾害: ["坍塌", "崩塌", "地基", "砖头", "支柱", "废墟"],
  仓储租赁: ["仓库", "库房", "租金", "取货", "入库", "库存"],
  道路竞赛: ["赛道", "跑道", "岔路", "十字路口", "终点线", "门票"],
  机器器官: ["齿轮", "引擎", "发动机", "血管", "骨架", "肌肉"],
  海洋航行: ["蓝海", "浪潮", "潮水", "航船", "灯塔", "彼岸"],
};

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ROAD_SIGN_PATTERNS: RegExp[] = [
  new RegExp(`(?:^|[。！？!?]\\s*)${escapeRe(ROAD_SIGNS[0])}[^。！？!?\\n]{0,24}`, "m"),
  new RegExp(
    `(?:^|[。！？!?]\\s*)${escapeRe(ROAD_SIGNS[1])}` +
      "(?=(?:更|原因|问题|意思|考虑|变化|逻辑|价值|作用|风险|影响|值得|很少|不容易|常被|往往))" +
      "[^。！？!?\\n]{0,24}",
    "m",
  ),
  ...ROAD_SIGNS.slice(2).map(
    phrase => new RegExp(`(?:^|[。！？!?]\\s*)${escapeRe(phrase)}[^。！？!?\\n]{0,24}`, "m"),
  ),
];

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

type Span = { start: number; end: number };

function hanCount(text: string): number {
  const hit = text.match(/[\u4e00-\u9fff]/g);
  return hit ? hit.length : 0;
}

function lineNumber(text: string, position: number): number {
  let count = 0;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count + 1;
}

function excerpt(value: string, width = 72): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= width ? clean : `${clean.slice(0, width - 1)}…`;
}

/**
 * 屏蔽代码、网址与机器元数据，但保持字符位置与换行不变。
 *
 * 位置不能变：后面所有报错的行号都靠它算。
 */
function maskNonProse(text: string): string {
  const patterns: RegExp[] = [
    /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/,
    /```[\s\S]*?```/,
    /`[^`\n]*`/,
    /\]\([^\n)]*\)/,
    /https?:\/\/[^\s)>]+/,
    /<[^>\n]+>/,
  ];
  let masked = text;
  for (const pattern of patterns) {
    masked = masked.replace(pattern, hit => hit.replace(/[^\n]/g, " "));
  }
  return masked;
}

/**
 * 找词，但长词优先、互不重叠。
 *
 * 「商业闭环」和「闭环」同时命中时只算前者——否则一句话会被报两次。
 */
function nonOverlappingTerms(text: string, terms: string[]): { position: number; term: string }[] {
  const matches: { position: number; term: string }[] = [];
  const occupied: Span[] = [];
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    let index = text.indexOf(term);
    while (index !== -1) {
      const start = index;
      const end = index + term.length;
      if (!occupied.some(span => start < span.end && end > span.start)) {
        matches.push({ position: start, term });
        occupied.push({ start, end });
      }
      index = text.indexOf(term, index + 1);
    }
  }
  return matches.sort((a, b) => a.position - b.position);
}

function allMatches(text: string, patterns: RegExp[]): (Span & { text: string })[] {
  const matches: (Span & { text: string })[] = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    let hit = global.exec(text);
    while (hit !== null) {
      matches.push({ start: hit.index, end: hit.index + hit[0].length, text: hit[0] });
      if (hit[0].length === 0) global.lastIndex++;
      hit = global.exec(text);
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** 主干可能被多个「的」压到后面的长句。 */
function heavyDeSentences(text: string): (Span & { text: string })[] {
  const matches: (Span & { text: string })[] = [];
  const pattern = /[^。！？!?\n]+(?:[。！？!?]|$)/g;
  let hit = pattern.exec(text);
  while (hit !== null) {
    const value = hit[0];
    if (hanCount(value) >= 38 && (value.match(/的/g) ?? []).length >= 4) {
      matches.push({ start: hit.index, end: hit.index + value.length, text: value });
    }
    hit = pattern.exec(text);
  }
  return matches;
}

/** 同一句里三个以上小句用同一个开头的排比。 */
function anaphoraRuns(text: string, minimum = 3): (Span & { text: string })[] {
  const matches: (Span & { text: string })[] = [];
  const pattern = /[^。！？!?\n]+(?:[。！？!?]|$)/g;
  let hit = pattern.exec(text);
  while (hit !== null) {
    const sentence = hit[0];
    const clauses = sentence
      .split(/[，、；,;]/)
      .map(item => item.trim())
      .filter(item => hanCount(item) >= 3);
    if (clauses.length >= minimum) {
      let run = 1;
      for (let i = 1; i < clauses.length; i++) {
        const previous = clauses[i - 1];
        const current = clauses[i];
        if (previous.slice(0, 2) === current.slice(0, 2) && /^[\u4e00-\u9fff]{2}/.test(current)) {
          run++;
          if (run >= minimum) {
            matches.push({ start: hit.index, end: hit.index + sentence.length, text: sentence });
            break;
          }
        } else {
          run = 1;
        }
      }
    }
    hit = pattern.exec(text);
  }
  return matches;
}

/**
 * 句长变异系数。
 *
 * 人写的长短句差距大；模型的句长彼此接近。系数太低说明全文节奏过于整齐。
 */
function sentenceLengthCv(text: string): { cv: number; count: number } | null {
  const lengths: number[] = [];
  const pattern = /[^。！？!?\n]+[。！？!?]/g;
  let hit = pattern.exec(text);
  while (hit !== null) {
    const count = hanCount(hit[0]);
    if (count >= 4) lengths.push(count);
    hit = pattern.exec(text);
  }
  if (lengths.length < 12) return null;
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (mean === 0) return null;
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  return { cv: Math.sqrt(variance) / mean, count: lengths.length };
}

/** 「」括起来的短语。太密说明在批量造金句。 */
function bracketHighlights(text: string): (Span & { text: string })[] {
  const matches: (Span & { text: string })[] = [];
  const pattern = /[「『][^」』\n]{1,6}[」』]/g;
  let hit = pattern.exec(text);
  while (hit !== null) {
    matches.push({ start: hit.index, end: hit.index + hit[0].length, text: hit[0] });
    hit = pattern.exec(text);
  }
  return matches;
}

type Paragraph = { position: number; text: string; han: number; sentences: number };

function proseParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let cursor = 0;
  for (const block of text.split(/\n\s*\n/)) {
    const position = text.indexOf(block, cursor);
    cursor = Math.max(position + block.length, cursor);
    const clean = block.replace(/[>*_`]/g, "").trim();
    if (!clean) continue;
    if (/^[#!]/.test(clean) || clean.startsWith("http") || clean.startsWith("```")) continue;
    if (/^(?:[-+*]|\d+[.、])\s/.test(clean)) continue;
    const count = hanCount(clean);
    if (count < 4) continue;
    const sentences = Math.max(1, (clean.match(/[。！？!?]/g) ?? []).length);
    paragraphs.push({ position: position < 0 ? 0 : position, text: clean, han: count, sentences });
  }
  return paragraphs;
}

/** 同一段里套了好几套比喻。 */
function metaphorCluster(text: string, distance = 800): { window: { position: number; word: string }[]; fields: string[] } | null {
  const hits: { position: number; field: string; word: string }[] = [];
  for (const [field, words] of Object.entries(METAPHOR_FIELDS)) {
    for (const word of words) {
      let index = text.indexOf(word);
      while (index !== -1) {
        hits.push({ position: index, field, word });
        index = text.indexOf(word, index + 1);
      }
    }
  }
  hits.sort((a, b) => a.position - b.position);
  for (let index = 0; index < hits.length; index++) {
    const start = hits[index].position;
    const window = hits.slice(index).filter(hit => hit.position - start <= distance);
    const fields = [...new Set(window.map(hit => hit.field))];
    if (fields.length >= 3) {
      return {
        window: window.map(hit => ({ position: hit.position, word: hit.word })),
        fields,
      };
    }
  }
  return null;
}

/** 连续四个只有一句话的短段。 */
function shortStreak(paragraphs: Paragraph[], limit = 4): Paragraph[] | null {
  let streak: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.han <= 24 && paragraph.sentences <= 1) {
      streak.push(paragraph);
      if (streak.length >= limit) return streak;
    } else {
      streak = [];
    }
  }
  return null;
}

/** 段落的固定开场。 */
function openerCounts(paragraphs: Paragraph[]): { counts: Map<string, number>; examples: Map<string, number> } {
  const counts = new Map<string, number>();
  const examples = new Map<string, number>();
  for (const paragraph of paragraphs) {
    const value = paragraph.text.replace(/^[“‘"（(]+/, "");
    for (const opener of REPEATED_OPENERS) {
      if (value.startsWith(opener)) {
        counts.set(opener, (counts.get(opener) ?? 0) + 1);
        if (!examples.has(opener)) examples.set(opener, paragraph.position);
        break;
      }
    }
  }
  return { counts, examples };
}

function countMap(terms: { term: string }[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of terms) result.set(item.term, (result.get(item.term) ?? 0) + 1);
  return result;
}

/**
 * 找某个符号的出现位置。
 *
 * 破折号按「连续一段算一处」计：中文破折号是两个字符连写（——），
 * 按字符数会报成「共 2 处」，跟人说的「我写了一处破折号」对不上。
 */
function symbolPositions(prose: string, symbol: string): number[] {
  const positions: number[] = [];
  let index = 0;
  while (index < prose.length) {
    const found = prose.indexOf(symbol, index);
    if (found === -1) break;
    positions.push(found);
    index = found + 1;
    if (symbol === "—" || symbol === "–") {
      while (index < prose.length && prose[index] === symbol) index++;
    }
  }
  return positions;
}

/**
 * 把位置列表变成「第 N、M 行」这样的说明。
 *
 * 同一个符号在同一行出现多次时，行号只报一次——「第 3、3 行」看起来像坏了。
 */
function describeLines(text: string, positions: number[]): string {
  return [...new Set(positions.map(position => lineNumber(text, position)))].join("、");
}

function joinUnique(values: string[]): string {
  return [...new Set(values)].join("、");
}

/* ------------------------------------------------------------------ */
/* 主检查                                                              */
/* ------------------------------------------------------------------ */

/**
 * 检查一篇成稿。
 *
 * 返回结构化结果，界面与模型都用得上：
 * 硬禁令进 failures（fail），需要人判断的进 warnings（warn）。
 */
export function checkProse(text: string): ProseCheckResult {
  const prose = maskNonProse(text ?? "");
  const totalHan = hanCount(prose);
  const findings: ProseFinding[] = [];
  const summary: Record<string, number> = {};

  const fail = (kind: string, message: string, line?: number, fragment?: string) => {
    findings.push({ level: "fail", kind, message, ...(line ? { line } : {}), ...(fragment ? { excerpt: fragment } : {}) });
  };
  const warn = (kind: string, message: string, line?: number, fragment?: string) => {
    findings.push({ level: "warn", kind, message, ...(line ? { line } : {}), ...(fragment ? { excerpt: fragment } : {}) });
  };

  if (totalHan === 0) {
    return { hanCount: 0, summary: {}, findings: [], ok: true };
  }

  // 1. 禁用标点。冒号引出原话是可以的，单独归到提醒。
  const quoteColons: number[] = [];
  let punctuationCount = 0;
  for (const [symbol, label] of Object.entries(FORBIDDEN_PUNCTUATION)) {
    const positions = symbolPositions(prose, symbol);
    if (symbol === "：" || symbol === ":") {
      const hard: number[] = [];
      for (const position of positions) {
        const tail = prose.slice(position + 1, position + 3).replace(/^\s+/, "");
        if (["「", "『", "“", "‘", '"'].includes(tail.slice(0, 1))) quoteColons.push(position);
        else hard.push(position);
      }
      if (hard.length) {
        punctuationCount += hard.length;
        const lines = describeLines(text, hard.slice(0, 8));
        fail("punctuation", `${label}共 ${hard.length} 处，出现在第 ${lines} 行。`, lineNumber(text, hard[0]));
      }
      continue;
    }
    if (positions.length) {
      punctuationCount += positions.length;
      const lines = describeLines(text, positions.slice(0, 8));
      fail("punctuation", `${label}共 ${positions.length} 处，出现在第 ${lines} 行。`, lineNumber(text, positions[0]));
    }
  }
  if (quoteColons.length) {
    const lines = describeLines(text, quoteColons.slice(0, 8));
    warn(
      "punctuation",
      `引出原话的冒号 ${quoteColons.length} 处，第 ${lines} 行。确认引号里确实是原话，且不是提示性用法。`,
      lineNumber(text, quoteColons[0]),
    );
  }

  // 2. 硬停词。
  const stopMatches = nonOverlappingTerms(prose, HARD_STOPS);
  for (const item of stopMatches) {
    fail("hard-stop", `硬停词，第 ${lineNumber(text, item.position)} 行，${item.term}`, lineNumber(text, item.position), item.term);
  }

  // 3. 绝对禁用黑话。
  const jargonMatches = nonOverlappingTerms(prose, HARD_JARGON);
  for (const item of jargonMatches) {
    fail("hard-jargon", `黑话，第 ${lineNumber(text, item.position)} 行，${item.term}`, lineNumber(text, item.position), item.term);
  }

  // 4. 需要看语境的词。与硬黑话重叠的算硬黑话，不重复报。
  const hardSpans = jargonMatches.map(item => ({ start: item.position, end: item.position + item.term.length }));
  const contextJargonMatches = nonOverlappingTerms(prose, CONTEXT_JARGON).filter(
    item =>
      !hardSpans.some(
        span => item.position < span.end && item.position + item.term.length > span.start,
      ),
  );
  if (contextJargonMatches.length) {
    const samples = joinUnique(contextJargonMatches.map(item => item.term));
    const lines = joinUnique(contextJargonMatches.slice(0, 8).map(item => String(lineNumber(text, item.position))));
    warn(
      "context-jargon",
      `有 ${contextJargonMatches.length} 处词语需要结合语境判断。第 ${lines} 行出现 ${samples}。` +
        "本义准确时保留，用来抬价时改写。",
    );
  }

  // 5. 模型路标。
  const roadSigns = allMatches(prose, ROAD_SIGN_PATTERNS);
  for (const match of roadSigns) {
    fail(
      "road-sign",
      `模型路标，第 ${lineNumber(text, match.start)} 行，“${excerpt(match.text.replace(/^[。！？!? \n]+/, ""))}”`,
      lineNumber(text, match.start),
      excerpt(match.text),
    );
  }

  // 6. 翻案句（硬）与翻案腔变形（软）。
  const pivots = allMatches(prose, PIVOT_PATTERNS);
  for (const match of pivots) {
    fail(
      "pivot",
      `禁用翻案句，第 ${lineNumber(text, match.start)} 行，“${excerpt(match.text)}”`,
      lineNumber(text, match.start),
      excerpt(match.text),
    );
  }
  const occupiedSpans: Span[] = pivots.map(match => ({ start: match.start, end: match.end }));
  const semanticPivots: (Span & { text: string })[] = [];
  for (const match of allMatches(prose, SEMANTIC_PIVOT_PATTERNS)) {
    if (occupiedSpans.some(span => match.start < span.end && match.end > span.start)) continue;
    semanticPivots.push(match);
    occupiedSpans.push({ start: match.start, end: match.end });
  }
  for (const match of semanticPivots) {
    warn(
      "semantic-pivot",
      `疑似翻案腔变形，第 ${lineNumber(text, match.start)} 行，“${excerpt(match.text, 44)}”。` +
        "先立误解再推翻就改成正面陈述，正常用法保留。",
      lineNumber(text, match.start),
      excerpt(match.text, 44),
    );
  }

  // 7. 三连以上同构排比。
  const anaphoras = anaphoraRuns(prose);
  for (const match of anaphoras.slice(0, 4)) {
    warn(
      "anaphora",
      `三连以上同构排比，第 ${lineNumber(text, match.start)} 行，“${excerpt(match.text, 44)}”。` +
        "留两项，第三项换说法或删掉。",
      lineNumber(text, match.start),
      excerpt(match.text, 44),
    );
  }

  // 8. 模型偏爱的抒情词。
  const lyricMatches = nonOverlappingTerms(prose, LYRIC_WORDS);
  if (lyricMatches.length >= 2) {
    warn(
      "lyric",
      `模型偏爱的抒情词 ${lyricMatches.length} 处。${joinUnique(lyricMatches.map(item => item.term))}。` +
        "写具体事物时保留，给抽象概念穿衣服时删掉。",
    );
  }

  // 9. 名词化句式。
  const nominalizations = allMatches(prose, NOMINALIZATION_PATTERNS);
  for (const match of nominalizations.slice(0, 4)) {
    warn(
      "nominalization",
      `名词化句式，第 ${lineNumber(text, match.start)} 行，“${excerpt(match.text, 36)}”。还原成直接的动词。`,
      lineNumber(text, match.start),
      excerpt(match.text, 36),
    );
  }

  // 10. 连词密度。
  const conjunctionHits = nonOverlappingTerms(prose, CONJUNCTIONS);
  if (totalHan >= 600 && (conjunctionHits.length * 1000) / totalHan > 7) {
    const top = [...countMap(conjunctionHits).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([term, count]) => `${term} ${count} 次`)
      .join("、");
    warn(
      "conjunction",
      `连词密度偏高，每千字 ${Math.floor((conjunctionHits.length * 1000) / totalHan)} 个。${top}。` +
        "中文小句靠语序和事理相接，删掉一半试试。",
    );
  }

  // 11. 「」金句密度。
  const highlights = bracketHighlights(prose);
  const highlightLimit = Math.max(3, Math.floor(totalHan / 700));
  if (highlights.length > highlightLimit) {
    warn(
      "highlight",
      `「」括起的短语共 ${highlights.length} 处。${joinUnique(highlights.slice(0, 6).map(item => item.text))}。` +
        "太密说明在批量造金句。",
    );
  }

  // 12. 句长整齐度。
  const cv = sentenceLengthCv(prose);
  if (cv && cv.cv < 0.42) {
    warn(
      "rhythm",
      `全文 ${cv.count} 个句子长度过于接近（变异系数 ${cv.cv.toFixed(2)}）。` +
        "人写的段落里十个字的句子会挨着四十个字的句子，放开几句，压短几句。",
    );
  }

  // 13. 洞察路标。
  const markerMatches = nonOverlappingTerms(prose, SOFT_MARKERS);
  const markerLimit = Math.max(2, Math.floor(totalHan / 900));
  if (markerMatches.length > markerLimit) {
    warn(
      "soft-marker",
      `洞察路标共 ${markerMatches.length} 处，当前提醒线为 ${markerLimit} 处。` +
        `重点检查 ${joinUnique(markerMatches.map(item => item.term))}。`,
    );
  }

  // 14. 长前置成分。
  const leftBranches = allMatches(prose, LEFT_BRANCH_PATTERNS);
  const leftLimit = Math.max(2, Math.floor(totalHan / 1200));
  if (leftBranches.length > leftLimit) {
    const samples = leftBranches
      .slice(0, 4)
      .map(match => `第 ${lineNumber(text, match.start)} 行“${excerpt(match.text, 44)}”`)
      .join("；");
    warn("left-branch", `长前置成分共 ${leftBranches.length} 处，可能让主干来得太晚。${samples}`);
  }

  // 15. 多个「的」压住主干。
  const denseDe = heavyDeSentences(prose);
  const denseDeLimit = Math.max(1, Math.floor(totalHan / 1500));
  if (denseDe.length > denseDeLimit) {
    const samples = denseDe
      .slice(0, 4)
      .map(match => `第 ${lineNumber(text, match.start)} 行“${excerpt(match.text, 44)}”`)
      .join("；");
    warn("heavy-de", `有 ${denseDe.length} 个长句包含四个以上的“的”，可能要先交代人和动作。${samples}`);
  }

  // 16. 段落形状：单句段过多、短段排队、固定开场、多套比喻。
  const paragraphs = proseParagraphs(prose);
  if (paragraphs.length >= 10) {
    const oneSentence = paragraphs.filter(paragraph => paragraph.sentences <= 1).length;
    const ratio = oneSentence / paragraphs.length;
    if (ratio >= 0.75) {
      warn("uniform-paragraph", `可识别段落中有 ${Math.round(ratio * 100)}% 只有一句话，可能形成统一的短段鼓点。`);
    }
  }

  const streak = shortStreak(paragraphs);
  if (streak) {
    const first = streak[0];
    warn(
      "short-streak",
      `从第 ${lineNumber(text, first.position)} 行起连续出现 ${streak.length} 个短促单句段，检查是否在排队喊结论。`,
      lineNumber(text, first.position),
    );
  }

  const { counts, examples } = openerCounts(paragraphs);
  const repeated = [...counts.entries()].filter(([, count]) => count >= 4);
  if (repeated.length) {
    const details = repeated.map(([opener, count]) => `${opener} ${count} 次`).join("、");
    const firstPosition = Math.min(...repeated.map(([opener]) => examples.get(opener) ?? 0));
    warn(
      "repeated-opener",
      `段落开场重复，从第 ${lineNumber(text, firstPosition)} 行附近开始。${details}。`,
      lineNumber(text, firstPosition),
    );
  }

  const metaphors = metaphorCluster(prose);
  if (metaphors) {
    const samples = joinUnique(metaphors.window.map(hit => hit.word));
    warn(
      "metaphor",
      `八百字内出现 ${metaphors.fields.length} 套借喻。${[...metaphors.fields].sort().join("、")}。例词有 ${samples}。`,
    );
  }

  // 17. 重复表达。
  // 稿台自己会制造重复：补写常常在加完事实之后又复述一遍本节的结论，
  // 全文写完之后那些结论句就散落在各处，看着像在反复说同一件事。
  const repetitions = findRepetitions(text);
  for (const item of repetitions) {
    if (item.level === "fail") {
      fail("repetition", item.message, item.line, item.excerpt);
    } else {
      warn("repetition", item.message, item.line, item.excerpt);
    }
  }

  summary["禁用标点"] = punctuationCount;
  summary["硬停词"] = stopMatches.length;
  summary["黑话"] = jargonMatches.length;
  summary["需辨语境词"] = contextJargonMatches.length;
  summary["模型路标"] = roadSigns.length;
  summary["翻案句"] = pivots.length;
  summary["翻案腔变形"] = semanticPivots.length;
  summary["同构排比"] = anaphoras.length;
  summary["名词化"] = nominalizations.length;
  summary["抒情词"] = lyricMatches.length;
  summary["洞察路标"] = markerMatches.length;
  summary["长前置成分"] = leftBranches.length;
  summary["重定语句"] = denseDe.length;
  summary["重复表达"] = repetitions.length;

  return {
    hanCount: totalHan,
    summary,
    findings,
    ok: !findings.some(item => item.level === "fail"),
  };
}

/**
 * 把检查结果写成给模型看的一段话。
 *
 * 模型读懂「哪里错了、错在哪一行」比读懂规则表有用得多。
 */
export function renderProseReport(result: ProseCheckResult): string {
  if (!result.findings.length) {
    return `体检通过：${result.hanCount} 字，未发现硬禁令，也没有需要人工判断的形状问题。`;
  }
  const fails = result.findings.filter(item => item.level === "fail");
  const warns = result.findings.filter(item => item.level === "warn");
  const lines: string[] = [];
  if (fails.length) {
    lines.push(`必须修改（${fails.length} 项）：`);
    for (const item of fails) lines.push(`- ${item.message}`);
  }
  if (warns.length) {
    lines.push(`需要人工判断（${warns.length} 项）：`);
    for (const item of warns) lines.push(`- ${item.message}`);
  }
  lines.push("只报警不改文：请自己去找这些句子的原意，用普通句子说出来。");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 模型侧工具                                                          */
/* ------------------------------------------------------------------ */

/**
 * 给模型用的体检工具。
 *
 * 技能包里的 SKILL.md 写的是「初稿写完以后运行 scripts/check_prose.py」，
 * 但桌面客户端不能指望用户机器上有 Python，也没有可执行的脚本通道。
 * 所以稿台把它做成了工具：模型写完初稿，自己调一次 check_prose，
 * 拿到违规清单，自己去改——技能里的那条指令因此在稿台里真的能执行。
 */
export const proseCheckTool: ChatTool = {
  type: "function",
  function: {
    name: "check_prose",
    description:
      "检查一篇中文成稿里的硬禁令与模型化写法：中文冒号、破折号、「不是……而是……」翻案句、" +
      "硬停词、绝对禁用黑话、模型路标，以及同构排比、名词化、句长过于整齐等形状问题。" +
      "只报警，不改文。初稿写完先自查一遍，再按清单把句子改成普通说法。" +
      "不传 text 时检查你上一条消息里写的正文。此工具不联网、不执行脚本，只做本地文本检查。",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "要检查的正文；不填则检查你上一条消息里写的正文。",
        },
      },
    },
  },
};

/** 取对话里最近一条助手消息的正文——那通常就是模型刚写的草稿。 */
export function lastAssistantText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim()) return message.content;
  }
  return "";
}

/**
 * 执行体检工具。
 *
 * 没给 text 就退到「检查你上一条消息」，模型自己写的草稿因此不用再抄一遍。
 */
export function runProseCheck(
  args: Record<string, unknown>,
  context?: { messages?: ChatMessage[] },
): string {
  const explicit = typeof args.text === "string" ? args.text : "";
  const text = explicit.trim() || lastAssistantText(context?.messages ?? []);
  if (!text.trim()) {
    return "没有可检查的正文：既没有传 text，上一条消息也没有内容。";
  }
  const result = checkProse(text);
  if (result.hanCount === 0) {
    return "没有检测到汉字，无法体检。";
  }
  return renderProseReport(result);
}
