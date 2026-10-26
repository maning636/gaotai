/**
 * 全文字数目标。
 *
 * 要解决的是一个具体的脱节：大纲末尾写着「总字数估算 2200–2500 字」，
 * 拿到的正文却只有 1491 字。这两个数字从头到尾没有在任何一处对过账，
 * 用户看到估算和拿到稿子对不上，只能自己判断是模型偷懒还是大纲在骗人。
 *
 * 目标从三个地方找，优先级从高到低：
 * 1. 本次用户输入里写的字数（「写 2000 字左右」）；
 * 2. 已确认大纲里的总字数估算；
 * 3. 已确认材料解读里写的篇幅。
 *
 * 找不到就返回 null。没有目标就不硬凑字数——
 * 材料撑不住的时候，一篇短而实的稿子比一篇注水的稿子有用。
 */

/** 目标是从哪儿来的。界面要把这个说清楚，否则用户不知道这个数字凭什么。 */
export type LengthSource = "input" | "outline" | "angle" | "brief" | "default";

export type LengthTarget = {
  /** 目标下限。0 表示没有下限。 */
  min: number;
  /** 目标上限。0 表示没有上限。 */
  max: number;
  source: LengthSource;
  /** 原话。回显给用户时用它，不要自己编一个说法。 */
  raw: string;
};

/** 目标来源的中文名。 */
export const LENGTH_SOURCE_LABELS: Record<LengthSource, string> = {
  input: "用户要求",
  outline: "大纲的总字数估算",
  angle: "选题给的适合篇幅",
  brief: "材料里定的篇幅",
  default: "默认篇幅",
};

/**
 * 把模型自己定的篇幅收进默认区间。
 *
 * 作者 2026-10-23 定的规矩：公众号未来只做 700–1200 字。
 * 这条规矩**不能只写在提示词里**——真模型实测（2026-10-23）：
 * 大纲阶段明明白白被要求「各段相加落在 700–1200」，
 * 它交出来的总账是 1520–1920 字（八段，每段 180–300 字，每段看着都合理，
 * 加起来却越了界）。
 *
 * 提示词管不住模型，规矩得由代码来守。守法是：
 * **模型给的数只能在这个区间里收窄，不能把稿子推出区间。**
 * - 区间相交 → 用交集（模型给 900–1100，就写 900–1100）；
 * - 整段超出上限 → 用默认区间（模型给 1520–1920，就写 700–1200）；
 * - 整段低于下限 → 照它的来。材料撑不住的时候，一篇短而实的稿子
 *   比一篇注水的稿子有用，稿台不硬凑。
 *
 * 明确来自用户的要求不受这条限制——界面上手填的「目标字数」，
 * 或者输入里明确在谈篇幅的那句话，都是作者自己的意图，作者说了算。
 */
export function clampToEnvelope(target: LengthTarget, envelope: LengthTarget): LengthTarget {
  if (target.source === "input") return target;
  if (!envelope || envelope.min <= 0 || envelope.max <= 0) return target;

  const lo = target.min > 0 ? Math.max(target.min, envelope.min) : envelope.min;
  const hi = target.max > 0 ? Math.min(target.max, envelope.max) : envelope.max;

  if (lo <= hi) {
    if (lo === target.min && hi === target.max) return target;
    return {
      ...target,
      min: lo,
      max: hi,
      raw: `${target.raw}（收进默认篇幅 ${envelope.min}–${envelope.max} 字）`,
    };
  }

  // 交集为空：模型要的整段都在区间外。
  if (target.min > envelope.max) {
    return {
      min: envelope.min,
      max: envelope.max,
      source: "default",
      raw: `${target.raw}（超出默认篇幅 ${envelope.min}–${envelope.max} 字，按默认篇幅写）`,
    };
  }
  // 整段比下限还短：照旧的，不硬凑。
  return target;
}

/**
 * 按目标字数算一份分段建议。
 *
 * 模型越界有一个很具体的原因：700–1200 字的稿子，它照样分八段，
 * 每段给 200 字——每段单看都合理，加起来一千六。
 * 所以不能只说「落在这个数上」，要把**段数和每段多少字直接摆给它**：
 * 「大约分 4 段，每段 175–300 字」，它才知道该分几段。
 */
export function planSectionCount(target: LengthTarget): {
  /** 建议分几段。 */
  sections: number;
  /** 每段的下限。 */
  perMin: number;
  /** 每段的上限。 */
  perMax: number;
} {
  const mid = target.min > 0 && target.max > 0
    ? (target.min + target.max) / 2
    : (target.min || target.max || 0);
  const sections = Math.min(8, Math.max(3, Math.round(mid / 240)));
  const perMin = Math.max(80, Math.floor((target.min || mid) / sections));
  const perMax = Math.max(perMin, Math.ceil((target.max || mid) / sections));
  return { sections, perMin, perMax };
}


/**
 * 兜底的篇幅。
 *
 * 稿台是写公众号的，公众号的稿子天生是短的：写长了观点被稀释，
 * 读者读不完（作者 2026-10-23 明说：不想太多输出，
 * 太多输出会影响观点，也影响人家读完）。
 *
 * 所以用户没写字数、大纲里也没有总账的时候，按这个来，
 * 而不是放开了写——放开写出来的多半是三千字，那不是公众号文章。
 */
export const DEFAULT_ARTICLE_LENGTH: LengthTarget = {
  min: 700,
  max: 1200,
  source: "default",
  raw: "默认 700–1200 字",
};

/* ------------------------------------------------------------------ */
/* 中间产物的字数预算                                                  */
/* ------------------------------------------------------------------ */

/**
 * 一道中间工序的产物该有多长。
 *
 * **为什么要单独定，不能跟着正文走。**
 *
 * 真模型实测（2026-10-23 03:00，700–1200 字主线）：
 * 材料解读 2269 字、选题 2288 字、大纲 1788 字，正文目标 900 字——
 * **中间产物比交付物还长一倍**。而且大纲的每一段里，「内容」字段是 200 多字的散文，
 * 模型等于在大纲阶段就把正文写了一遍，到正文阶段再写一遍。
 *
 * 后果不只是难看：
 * - 正文阶段的请求上下文被撑到 25KB（材料解读 + 选题 + 大纲 + 系统提示 + 技能包目录），
 *   交付物才 1.8KB。上下文越长，模型思考越重、每一轮越慢，
 *   8192 的额度被思考吃光 → 正文一个字都没有 → 白等十分钟。
 * - 大纲越长，正文阶段要消化的东西越多，越容易重复表达同一件事
 *   （同一句话讲两遍是硬禁令，闸门要改，闸门改写又要模型调用）。
 *
 * 所以中间产物必须**比正文短**，而且短得多：它是施工图，不是草稿。
 */
export type StageOutputBudget = {
  /** 这一道工序产物的字数上限。 */
  max: number;
  /** 怎么跟模型说这件事。 */
  instruction: string;
};

/**
 * 三道中间工序各自的字数上限。
 *
 * 数字是量出来的，不是拍的：
 * - 大纲 700 字：4 段 × 每段 150 字刚好够写清「目的 / 素材 / 篇幅 / 形式」，
 *   还能装下全文主张、推进线和「说话位置」那四行。真模型那次写了 1788 字，
 *   是上限的 3 倍；说话位置是后加的，所以上限从 600 提到了 700。
 * - 选题 700 字：3 个角度 × 每个 7 项 × 每项 45 字。
 *   真模型写了 1142 字——只给整份上限它会超，所以每一项还得单独有宽度。
 * - 材料解读 800 字：事实、判断、疑点、缺口、角度各一小节。
 *
 * 篇幅目标（正文的 700–1200 字）跟这三个数字是两码事：
 * 前者是**交付物**有多长，后者是**中间产物**有多长。
 * 之前只有前者，模型就以为中间工序也该写那么长——
 * 提示词里说「这是施工图」不够，得给它一个具体的字数上限。
 */
export const STAGE_OUTPUT_BUDGETS = {
  /** 大纲。施工图。 */
  outline: {
    max: 700,
    instruction:
      "整份大纲控制在 700 字以内。开头的主张、推进线、说话位置四行加起来不超过 100 字；" +
      "每一段的「内容」用一句话说清要点，不超过 40 字；" +
      "「目的」「素材」「形式」各不超过 25 字，一段加起来不超过 100 字。" +
      "大纲是施工图，不是草稿——正文留给下一阶段写。",
  },
  /** 选题。三个角度的提案。 */
  angle: {
    max: 700,
    instruction:
      "整份选题控制在 700 字以内。3 个角度，每个角度 7 项，每项一行不超过 45 字。" +
      "这是提案，不是文章——每一项写完就换下一项，不要展开成段落。",
  },
  /** 材料解读。事实清单。 */
  brief: {
    max: 800,
    instruction:
      "整份材料解读控制在 800 字以内。硬事实最多 8 条、作者的判断最多 3 条、" +
      "可疑或待核实最多 4 条、信息缺口最多 3 条、值得切入的角度给 3 个，" +
      "每条一行，不超过 40 字。不要复述材料原文，不要展开评论。",
  },
} as const;

/**
 * 给某一道中间工序的字数上限。
 * 没配就返回 null（那一道工序不设上限）。
 */
export function stageOutputBudget(stage: keyof typeof STAGE_OUTPUT_BUDGETS): StageOutputBudget | null {
  return STAGE_OUTPUT_BUDGETS[stage] ?? null;
}

/* ------------------------------------------------------------------ */
/* 数字解析                                                            */
/* ------------------------------------------------------------------ */

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  贰: 2,
  两: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};

const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/**
 * 解析一个数：阿拉伯数字或者中文数字。
 *
 * 「两千三百」这类写法在中文里很常见，只认阿拉伯数字会漏掉一大半。
 */
export function parseNumberText(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);

  let section = 0;
  let current = 0;
  let matched = false;

  for (const ch of value) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
      matched = true;
      continue;
    }
    if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      // 「十」前面没有数字时按一十算（十二、十五）。
      section += (current || 1) * unit;
      current = 0;
      matched = true;
      continue;
    }
    // 出现了不认识的东西：整个串不算数。
    return null;
  }
  if (!matched) return null;
  return section + current;
}

/* ------------------------------------------------------------------ */
/* 从文字里找字数要求                                                  */
/* ------------------------------------------------------------------ */

const NUM = "(?:\\d{3,6}|[零〇壹一贰二两三叁四肆五伍六陆七柒八捌九玖十百千万]+)";
const UNIT = "\\s*(?:个\\s*)?(?:汉字|字)";

const RANGE_RE = new RegExp(`(${NUM})\\s*[-~～—–－至到]\\s*(${NUM})${UNIT}`, "g");
const SINGLE_RE = new RegExp(`(${NUM})${UNIT}`, "g");
const COUNT_RE = new RegExp(`字数\\s*[：:≈~约]?\\s*(${NUM})`, "g");

/** 少于这个数就不当成字数目标（太小，多半是碰巧撞上了「字」这个字）。 */
const MIN_PLAUSIBLE = 100;

const AT_LEAST_RE = /(?:不少于|不低于|至少|最少|起码|超过|多于)/;
const AT_MOST_RE = /(?:不超过|不多于|不多于|最多|不高于|不超过|封顶|上限)/;

type ParsedRange = { min: number; max: number; raw: string };

/**
 * 从一段文字里找出字数要求。
 *
 * 只认「数字 + 字」这种形态：材料里的「800 行代码」「5 万元」不会误判，
 * 而「2000 字」「两千字」「2200–2500 字」都能抓到。
 */
export function parseLengthRange(text: string): ParsedRange | null {
  if (!text) return null;

  RANGE_RE.lastIndex = 0;
  const range = RANGE_RE.exec(text);
  if (range) {
    const low = parseNumberText(range[1]);
    const high = parseNumberText(range[2]);
    if (low && high && low >= MIN_PLAUSIBLE && high >= MIN_PLAUSIBLE) {
      return { min: Math.min(low, high), max: Math.max(low, high), raw: range[0].trim() };
    }
  }

  SINGLE_RE.lastIndex = 0;
  const single = SINGLE_RE.exec(text);
  if (single) {
    const value = parseNumberText(single[1]);
    if (value && value >= MIN_PLAUSIBLE) {
      const before = text.slice(Math.max(0, single.index - 10), single.index);
      if (AT_MOST_RE.test(before)) {
        return { min: 0, max: value, raw: single[0].trim() };
      }
      if (AT_LEAST_RE.test(before)) {
        return { min: value, max: 0, raw: single[0].trim() };
      }
      return { min: value, max: value, raw: single[0].trim() };
    }
  }

  COUNT_RE.lastIndex = 0;
  const count = COUNT_RE.exec(text);
  if (count) {
    const value = parseNumberText(count[1]);
    if (value && value >= MIN_PLAUSIBLE) {
      return { min: value, max: value, raw: count[0].trim() };
    }
  }

  return null;
}

/**
 * 谈「要写多少字」时才会出现的词。
 *
 * 只有这些词出现在数字旁边，那句话才是在说篇幅。
 */
const LENGTH_INTENT_WORDS = [
  "写",
  "写成",
  "正文",
  "成稿",
  "全文",
  "篇幅",
  "字数",
  "控制",
  "不超过",
  "不少于",
  "至少",
  "最多",
];

/** 数字后面跟这些词，也算是在说篇幅（「1000 字左右」）。 */
const LENGTH_TAIL_WORDS = ["左右", "上下", "以内", "之间", "封顶", "之内", "以外"];

/**
 * 明显是在讲材料本身的句子。
 *
 * 这些句子里的字数是「素材有多长」，不是「稿子要写多长」。
 */
const MATERIAL_MARKERS = [
  "素材",
  "原文",
  "摘抄",
  "聊天记录",
  "笔记",
  "全文如下",
  "以上内容",
  "这段话",
  "以上这段",
];

/**
 * 从一段话里找「要写多少字」。
 *
 * 和 `parseLengthRange` 的区别只有一条，但这条很要紧：
 * **必须是明确在谈写作篇幅的时候才算数。**
 *
 * 「写 1000 字左右」「全文 1200 字」「成稿 800 字」算数；
 * 「这份素材大概 2500 字」不算数——那是素材有多长，不是稿子要写多长。
 *
 * 为什么要分这么清：输入往往就是两三千字的原话，
 * 里面随便一句「大概 2500 字」就被当成篇幅目标的话，
 * 稿台会认认真真写一篇 2500 字的稿子，而用户要的是 1000 字。
 *
 * 判据是同一句话里同时出现「谈篇幅的词」和「字数」，
 * 并且这句话不是明显在讲材料。
 */
export function parseWritingLength(text: string): ParsedRange | null {
  if (!text) return null;
  const sentences = text.split(/[。！？!?；;\n]+/);
  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (MATERIAL_MARKERS.some(marker => sentence.includes(marker))) continue;
    const range = findLengthInSentence(sentence);
    if (range) return range;
  }
  return null;
}

/** 在一句话里找字数，并检查这句话是不是在谈篇幅。 */
function findLengthInSentence(sentence: string): ParsedRange | null {
  RANGE_RE.lastIndex = 0;
  const rangeMatch = RANGE_RE.exec(sentence);
  if (rangeMatch) {
    const low = parseNumberText(rangeMatch[1]);
    const high = parseNumberText(rangeMatch[2]);
    if (
      low &&
      high &&
      low >= MIN_PLAUSIBLE &&
      high >= MIN_PLAUSIBLE &&
      talksAboutLength(sentence, rangeMatch.index)
    ) {
      return {
        min: Math.min(low, high),
        max: Math.max(low, high),
        raw: rangeMatch[0].trim(),
      };
    }
  }

  SINGLE_RE.lastIndex = 0;
  const singleMatch = SINGLE_RE.exec(sentence);
  if (singleMatch) {
    const value = parseNumberText(singleMatch[1]);
    if (value && value >= MIN_PLAUSIBLE && talksAboutLength(sentence, singleMatch.index)) {
      const before = sentence.slice(Math.max(0, singleMatch.index - 10), singleMatch.index);
      if (AT_MOST_RE.test(before)) return { min: 0, max: value, raw: singleMatch[0].trim() };
      if (AT_LEAST_RE.test(before)) return { min: value, max: 0, raw: singleMatch[0].trim() };
      return { min: value, max: value, raw: singleMatch[0].trim() };
    }
  }

  COUNT_RE.lastIndex = 0;
  const countMatch = COUNT_RE.exec(sentence);
  if (countMatch) {
    const value = parseNumberText(countMatch[1]);
    if (value && value >= MIN_PLAUSIBLE && talksAboutLength(sentence, countMatch.index)) {
      return { min: value, max: value, raw: countMatch[0].trim() };
    }
  }

  return null;
}

/**
 * 数字前面的那一小段里有没有在谈篇幅的词。
 *
 * 只看前面 12 个字：太远的话，「我写这份材料的时候想了很多，2500 字」
 * 也会被当成篇幅目标，那还是错的。
 */
function talksAboutLength(sentence: string, index: number): boolean {
  const before = sentence.slice(Math.max(0, index - 12), index);
  if (LENGTH_INTENT_WORDS.some(word => before.includes(word))) return true;
  const after = sentence.slice(index, index + 12);
  return LENGTH_TAIL_WORDS.some(word => after.includes(word));
}

/**
 * 界面上手填的字数目标。
 *
 * 手填的东西怎么写都认：「1000」「1000 字」「800-1200」「1200 字左右」都算。
 */
export function parseManualLength(text: string): ParsedRange | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const range = parseLengthRange(trimmed);
  if (range) return range;
  // 手填的时候人不一定写「字」：「800-1200」也得认。
  const bareRange = /^(\d{2,6})\s*[-~～—–－至到]\s*(\d{2,6})$/.exec(trimmed);
  if (bareRange) {
    const low = Number(bareRange[1]);
    const high = Number(bareRange[2]);
    if (low >= MIN_PLAUSIBLE && high >= MIN_PLAUSIBLE) {
      return { min: Math.min(low, high), max: Math.max(low, high), raw: trimmed };
    }
    return null;
  }
  const plain = /^(\d{2,6})$/.exec(trimmed);
  if (plain) {
    const value = Number(plain[1]);
    if (value >= MIN_PLAUSIBLE) return { min: value, max: value, raw: trimmed };
  }
  return null;
}

/**
 * 从大纲里找总字数估算。
 *
 * 优先找「总字数估算」那一行——那是模型自己声明的总账。
 * 找不到就把各段「篇幅」加起来，作为总账的替代。
 */
export function parseOutlineRange(outline: string): ParsedRange | null {
  if (!outline) return null;

  for (const line of outline.split(/\n+/)) {
    if (!/总字数|字数估算|全文字数|篇幅合计/.test(line)) continue;
    const parsed = parseLengthRange(line);
    if (parsed) return parsed;
  }

  // 退路：各段「篇幅」相加。
  let min = 0;
  let max = 0;
  let found = false;
  const sectionRe = /篇幅[：:]\s*([^\n]*)/g;
  let hit = sectionRe.exec(outline);
  while (hit) {
    const parsed = parseLengthRange(hit[1]);
    if (parsed) {
      found = true;
      min += parsed.min;
      max += parsed.max;
    }
    hit = sectionRe.exec(outline);
  }
  if (!found) return null;
  return { min: Math.max(min, MIN_PLAUSIBLE), max: Math.max(max, min), raw: "各段篇幅相加" };
}

/**
 * 从选题产出里找「适合篇幅」。
 *
 * 选题阶段本来就要求写这一条（它自己知道这篇稿子该写多长），
 * 大纲阶段没有用户明说的字数时就用它，比凭空猜一个强。
 */
export function parseAngleRange(angle: string): ParsedRange | null {
  if (!angle) return null;
  for (const line of angle.split(/\n+/)) {
    if (!/适合篇幅|篇幅建议|建议篇幅/.test(line)) continue;
    const parsed = parseLengthRange(line);
    if (parsed) return parsed;
  }
  return null;
}

/** 大纲里每一节的字数预算。 */
export type SectionBudget = {
  /** 节的序号与角色，原文里那一行的说法。 */
  label: string;
  min: number;
  max: number;
};

/**
 * 大纲标题里夹带的字数账。
 *
 * 提示词要求的是「篇幅：250–300 字」单独一行，但模型常常不照做——
 * 真模型实测（2026-10-22）：它把字数塞进了段落标题，
 * 写成「**第 4 段·论据（480-520 字）**」，`篇幅` 那一行根本没有。
 * 只认「篇幅：」的行，等于把整份字数账丢掉——
 * 逐节预算、结构锁、按节补写全都无从谈起。
 * 所以这里两种形态都要认。
 */
export function parseLabelLength(label: string): { min: number; max: number } | null {
  if (!label) return null;
  // 先看括号里的（「（480-520 字）」），没有再看整行。
  const paren = /[（(]([^）)]*)[）)]/.exec(label);
  const scope = paren ? paren[1] : label;

  const range = /(\d{2,6})\s*[-~～—–至到]\s*(\d{2,6})/.exec(scope);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (low >= MIN_PLAUSIBLE && high >= MIN_PLAUSIBLE) {
      return { min: Math.min(low, high), max: Math.max(low, high) };
    }
  }

  const single = /(\d{2,6})\s*字/.exec(scope);
  if (single) {
    const value = Number(single[1]);
    if (value >= MIN_PLAUSIBLE) return { min: value, max: value };
  }

  return null;
}

/**
 * 从大纲里逐节取出字数预算。
 *
 * 大纲的每一段都写了字数（多半是「篇幅：250–300 字」，
 * 也可能是「第 4 段·论据（480-520 字）」这种塞在标题里的写法），
 * 那才是真正能落地的字数账。
 * 只给一个全文总数，模型会把每一节都写短一点，总数就凑不上；
 * 把每一节的账单独摆出来，它才知道该在哪一节多写。
 */
export function parseOutlineSectionBudgets(outline: string): SectionBudget[] {
  if (!outline) return [];
  // 段落里没写字数账的不算。
  return parseOutlineParagraphs(outline)
    .filter(item => item.min > 0)
    .map(item => ({ label: item.label, min: item.min, max: item.max }));
}

/**
 * 把各段的字数账缩放到全文目标上。
 *
 * 大纲内部的字数账和用户这次的要求经常对不上：
 * 大纲是在「还没定字数」的时候写的，模型自己给每段安排了 400–500 字，
 * 八段加起来三千多；而用户在正文阶段说的是「2000 字左右」。
 *
 * 这时候提示词里会同时出现两个对不上的数字——
 * 「成稿落在 1800–2200 字」和「每段 440–500 字」。
 * 指令自相矛盾，模型不是写成三千字，就是写不到两千字；
 * 而按节补写是照着各段的账补的，补到最后字数对不上目标。
 *
 * 所以以全文目标为准，把各段的账等比缩放。
 * 差得不多（±一成以内）就不动——大纲的账本身可能有它的道理，
 * 为几秒钟的差别把用户已经确认过的大纲改掉，不划算。
 */
export function fitParagraphsToTarget(
  paragraphs: OutlineParagraph[],
  target: LengthTarget | null,
): OutlineParagraph[] {
  if (!target || target.min <= 0 || !paragraphs.length) return paragraphs;

  const budgeted = paragraphs.filter(item => item.min > 0);
  if (!budgeted.length) return paragraphs;

  const totalMin = budgeted.reduce((sum, item) => sum + item.min, 0);
  if (totalMin <= 0) return paragraphs;

  const ratio = target.min / totalMin;
  // 差得不多就不动：±一成以内的大纲账照用，用户的字面意思不受影响。
  if (ratio >= 0.9 && ratio <= 1.1) return paragraphs;

  return paragraphs.map(item => {
    if (item.min <= 0) return item;
    return {
      ...item,
      min: Math.max(MIN_PLAUSIBLE, Math.round(item.min * ratio)),
      max: Math.max(MIN_PLAUSIBLE, Math.round(item.max * ratio)),
    };
  });
}

/**
 * 大纲里的一个段落，连同它的施工说明。
 *
 * 只有字数账是不够的：补写的时候要告诉模型这一节本来要讲什么，
 * 否则它只能靠字面凑数，写出来的内容和大纲对不上。
 */
export type OutlineParagraph = {
  /** 段的标签，原文里那一行的说法。 */
  label: string;
  /** 这一段要达到的目的。 */
  purpose: string;
  /**
   * 这一段让全文推进线发生的变化。
   *
   * 「推进线」是大纲的主干：读者读完时理解要往前挪一大截，
   * 每一段负责挪一点。段落角色不是套出来的，是推进线决定出来的，
   * 所以这一项比「目的」更贴近骨架本身。
   *
   * 老大纲没有这一项（只有目的/内容/素材/形式/篇幅），解析时留空，
   * 正文阶段退回用「目的」顶上。
   */
  advance: string;
  /** 这一段要写的内容。 */
  content: string;
  /** 这一段要用的素材。 */
  material: string;
  /** 这一段的写法。 */
  format: string;
  /** 原文里这一段的完整内容。 */
  raw: string;
  /** 字数下限。0 表示没写。 */
  min: number;
  /** 字数上限。0 表示没写。 */
  max: number;
};

/**
 * 把大纲拆成一个个段落。
 *
 * 真模型写大纲有两种常见形状，同一套提示词两种都出现过：
 *
 * 1. **结构式**：「> **第 N 段 · 角色**」开头的一组引用行，
 *    后面跟着目的、内容、素材、篇幅、形式几项。
 * 2. **散文式**：「开头怎么进」「中间几段分别讲什么」「结尾落点在哪里」三个小节，
 *    中间几段写成「第 2 段讲数据。后面跟一整段说明」。
 *
 * 只认第一种的话，散文式大纲会被解析成「标签是整句话、目的为空」的假段落，
 * 而且开头和结尾两节整段消失——正文就没有钩子、没有落点了。
 * 更糟的是空目的会让分节写作的提示词残缺：模型拿到一个没有任务的请求，
 * 就陷进逐条猜的思考里，8192 额度全被思考吃光，正文一个字都没有
 * （真模型实测：finish_reason=length，reasoning_tokens=8192，content 空）。
 *
 * 所以两种都认，优先用带字数账的那种。
 */
export function parseOutlineParagraphs(outline: string): OutlineParagraph[] {
  if (!outline) return [];
  const structured = parseStructuredOutline(outline);
  const prose = parseProseOutline(outline);
  // 结构式更好就用结构式：它带字数账，每一项也是分开的。
  if (structured.length >= 2 && structured.some(item => item.purpose || item.content)) {
    return structured;
  }
  if (prose.length >= 2) return prose;
  return structured.length ? structured : prose;
}

/**
 * 剥掉一行上装的 markdown 装饰，只留下文字本身。
 *
 * 大纲的段落标题，模型会写成好几种样子，解析器必须比提示词更宽容——
 * 改一次提示词，模型就会换一个写法，一换写法整条工序就废：
 *
 * - `> **第 1 段 · 钩子**`（引用块 + 粗体）
 * - `## 第 1 段 · 钩子`（markdown 标题）
 * - `### 第 1 段 · 钩子`
 * - `**第 1 段 · 钩子**`（光粗体）
 * - `- 第 1 段 · 钩子`（列表项）
 *
 * 2026-10-23 实测踩过：提示词里写的是引用块形状，模型交回来的是 `## 第 1 段`，
 * 行首的 `##` 没被剥掉，标题正则不匹配 → 解析出 0 段 → 分节退路失效 →
 * 正文阶段空等 6 分钟才报错。
 *
 * 顺序要紧：先剥引用块和标题标记，再剥粗体，最后才剥列表符号。
 */
function stripOutlineMarkers(raw: string): string {
    return raw
        .replace(/^\s*>\s*/, "")
        .replace(/^\s*#{1,6}\s*/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/\*\*/g, "")
        .trim();
}

/**
 * 结构式大纲：段落标题后面跟着目的、内容、素材、篇幅、形式几项。
 * 这里按「第 N 段」切块，把各项分别取出来。
 */
function parseStructuredOutline(outline: string): OutlineParagraph[] {
  const paragraphs: OutlineParagraph[] = [];
  let current: OutlineParagraph | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!current) return;
    current.raw = buffer.join("\n").trim();
    buffer = [];
    paragraphs.push(current);
    current = null;
  };

  for (const raw of outline.split(/\r?\n/)) {
    const line = stripOutlineMarkers(raw);
    // 段落标题必须出现在行首。
    // 不能用「包含」来判断：真模型写的大纲里有「素材：材料第 3 段的对比数据。」，
    // 这种行里也有「第 3 段」，按包含切会把一段拆成好几段（实测 8 段被切成 20 段）。
    if (/^第\s*\d+\s*段/.test(line)) {
      flush();
      // 字数可能写在这行标题里（「第 4 段·论据（480-520 字）」），
      // 也可能写在下面的「篇幅：」那一行。两种都认，以「篇幅」那行为准。
      const labelLength = parseLabelLength(line);
      current = {
        label: line,
        purpose: "",
        advance: "",
        content: "",
        material: "",
        format: "",
        raw: "",
        min: labelLength ? labelLength.min : 0,
        max: labelLength ? labelLength.max : 0,
      };
      buffer = [line];
      continue;
    }
    if (!current) continue;

    // 字段名要认全：老大纲只有目的/内容/素材/形式/篇幅，
    // 新大纲多了「推进」。两套都要认——用户可以手改模板，形状随时会变。
    const picked = /^(推进|目的|内容|素材|形式|篇幅)[：:]\s*(.*)$/.exec(line);
    if (picked) {
      const key = picked[1];
      const value = picked[2].trim();
      if (key === "推进") current.advance = value;
      else if (key === "目的") current.purpose = value;
      else if (key === "内容") current.content = value;
      else if (key === "素材") current.material = value;
      else if (key === "形式") current.format = value;
      else if (key === "篇幅") {
        const parsed = parseLengthRange(value);
        if (parsed) {
          current.min = parsed.min;
          current.max = parsed.max;
        }
      }
    }
    buffer.push(line);
  }
  flush();

  return paragraphs;
}

/**
 * 散文式大纲里的小节标题。
 *
 * 「开头怎么进」「结尾落点在哪里」这两个小节在结构式大纲里是段落的字段，
 * 在散文式大纲里是独立小节——两种都要认。
 */
const PROSE_SECTIONS: Array<{ match: RegExp; kind: "head" | "middle" | "tail" }> = [
  { match: /^开头(怎么进|如何进|怎么开头|怎么写)?$/, kind: "head" },
  {
    match: /^(中间几段(分别讲什么)?|中间(几段)?(分别)?讲什么|中段(分别讲什么)?|正文分段)$/,
    kind: "middle",
  },
  { match: /^(结尾(落点(在哪里)?)?|落点(在哪里)?|结尾怎么落|收束)$/, kind: "tail" },
];

/**
 * 认散文式大纲。
 *
 * 样子（真模型实测）：
 *
 * ```
 * **开头怎么进**
 * 用一位写了 12 年代码的同事的原话直接开场……
 *
 * **中间几段分别讲什么**
 * 第 2 段讲数据。14 人团队 6 人用了 AI，4 人说省了时间……
 *
 * 第 3 段讲反方。先接住「行数少就是少维护」这个反驳……
 *
 * **结尾落点在哪里**
 * 落点在边界条件和下一步动作。先回答「什么时候 AI 真的能省出工作量」……
 * ```
 */
function parseProseOutline(outline: string): OutlineParagraph[] {
  const paragraphs: OutlineParagraph[] = [];

  // 先按粗体小标题把大纲切成块。
  const blocks: Array<{ heading: string; lines: string[] }> = [];
  let heading = "";
  let lines: string[] = [];
  for (const raw of outline.split(/\r?\n/)) {
    const line = raw.trim();
    const bold = /^\*\*(.+?)\*\*$/.exec(line);
    if (bold) {
      if (heading || lines.length) blocks.push({ heading, lines });
      heading = bold[1].trim();
      lines = [];
      continue;
    }
    lines.push(line);
  }
  if (heading || lines.length) blocks.push({ heading, lines });

  for (const block of blocks) {
    const text = block.lines.join("\n").trim();
    if (!text) continue;
    const kind = PROSE_SECTIONS.find(item => item.match.test(block.heading))?.kind;
    if (kind === "middle") {
      // 中间几段：按空行切，每一块是一段。
      for (const piece of text.split(/\n{2,}/)) {
        const item = proseParagraph(piece.trim());
        if (item) paragraphs.push(item);
      }
      continue;
    }
    if (kind === "head" || kind === "tail") {
      paragraphs.push({
        label: kind === "head" ? "开头·钩子" : "结尾·落点",
        purpose: text,
        advance: "",
        content: "",
        material: "",
        format: "",
        raw: text,
        min: 0,
        max: 0,
      });
      continue;
    }
    // 没有小节标题时，「第 N 段……」直接摊在正文里，也认。
    const item = proseParagraph(text);
    if (item) paragraphs.push(item);
  }

  return paragraphs;
}

/**
 * 从「第 2 段讲数据。后面是一整段说明」里拆出标签和说明。
 *
 * 标签只取第一个句号前面那几个字（「讲数据」），
 * 整句话当标签的话，提示词里会出现一个上百字的段名，模型读着费劲。
 */
function proseParagraph(text: string): OutlineParagraph | null {
  if (!text) return null;
  const matched = /^第\s*(\d+)\s*段\s*([^。.：:\n]{0,24})[。.：:]?\s*([\s\S]*)$/.exec(text);
  if (!matched) return null;
  const number = matched[1];
  const role = matched[2].trim();
  const rest = matched[3].trim();
  // 后面那整段说明就是这一段要写什么。
  const purpose = rest || role;
  if (!purpose) return null;
  return {
    label: role ? `第 ${number} 段·${role}` : `第 ${number} 段`,
    purpose,
    advance: "",
    content: "",
    material: "",
    format: "",
    raw: text,
    min: 0,
    max: 0,
  };
}

/**
 * 解析一个字数目标。
 *
 * 顺序即优先级：用户这次说的最算数，其次是大纲的总账，
 * 再次是选题阶段给的适合篇幅，然后是材料里写的，
 * 最后才轮到默认篇幅。
 *
 * 「用户这次说的」有两层：
 * 1. 界面上手填的字数目标（最明确）；
 * 2. 输入框里明确在谈写作篇幅的那句话（「写 1000 字左右」）。
 *
 * 注意第 2 条**不是**把输入里的字数全认下来：
 * 输入往往就是两千多字的原话，里面「大概 2500 字」说的是素材有多长，
 * 不是稿子要写多长。所以只认明确在谈篇幅的那句话（见 parseWritingLength）。
 */
export function resolveLengthTarget(input: {
  /** 本次用户输入。 */
  userInput?: string;
  /** 已确认的大纲。 */
  outline?: string;
  /** 已确认的选题与方向。 */
  angle?: string;
  /** 已确认的材料解读。 */
  brief?: string;
  /** 界面上手填的字数目标。 */
  manual?: string;
  /** 兜底篇幅。不给就没有目标。 */
  defaultTarget?: LengthTarget | null;
  /**
   * 模型给的篇幅不许越过的区间。
   *
   * 不给就不封顶。给了的话，模型自己写的数（大纲的总账、选题的适合篇幅、
   * 材料里定的篇幅）只能在个区间里收窄，推不出去；
   * 用户自己说的数不在限制之内。
   */
  envelope?: LengthTarget | null;
}): LengthTarget | null {
  const manual = input.manual?.trim() ? parseManualLength(input.manual) : null;
  if (manual) return { ...manual, source: "input" };

  const fromInput = parseWritingLength(input.userInput ?? "");
  if (fromInput) return { ...fromInput, source: "input" };

  const envelope = input.envelope ?? null;

  const fromOutline = parseOutlineRange(input.outline ?? "");
  if (fromOutline) {
    const target = { ...fromOutline, source: "outline" as const };
    return envelope ? clampToEnvelope(target, envelope) : target;
  }

  const fromAngle = parseAngleRange(input.angle ?? "");
  if (fromAngle) {
    const target = { ...fromAngle, source: "angle" as const };
    return envelope ? clampToEnvelope(target, envelope) : target;
  }

  const fromBrief = parseWritingLength(input.brief ?? "");
  if (fromBrief) {
    const target = { ...fromBrief, source: "brief" as const };
    return envelope ? clampToEnvelope(target, envelope) : target;
  }

  return input.defaultTarget ?? null;
}

/* ------------------------------------------------------------------ */
/* 给人看、给模型看的说法                                              */
/* ------------------------------------------------------------------ */

/** 把区间说成一句话。 */
export function describeLengthRange(target: LengthTarget): string {
  if (target.min > 0 && target.max > 0) {
    return target.min === target.max ? `${target.min} 字` : `${target.min}–${target.max} 字`;
  }
  if (target.min > 0) return `不少于 ${target.min} 字`;
  return `不超过 ${target.max} 字`;
}

/**
 * 写进提示词里的那几句话。
 *
 * **只有选题和大纲两道工序有字数指令，正文阶段没有。**
 *
 * 作者 2026-10-23 的原话：「到最后你限制他输出有个屁用啊」。
 * 正文的产出质量取决于两件事——大纲里那条线立不立得住，
 * 以及技能包里的写法有没有被用上；不在于提示词里有没有一个字数。
 * 硬塞一个数字进去只会多两件事：模型为了凑数而重复解释，
 * 以及稿台自己跟自己较劲（限制输出 = 制造返工）。
 *
 * 所以这里的 stage 类型里**没有 article**——
 * 不是「正文分支返回空」，是根本传不进来。
 *
 * 两个阶段说的也不是一件事：
 * - 选题阶段：给「适合篇幅」建议，要落在这个量级上；
 * - 大纲阶段：各段相加要对得上。
 */
export function renderLengthInstruction(
  target: LengthTarget | null,
  stage: "angle" | "outline",
): string {
  if (!target) {
    if (stage === "angle") return "本次没有指定字数。给每个角度的「适合篇幅」一个现实的估算，并说明依据。";
    return "本次没有指定字数。给每一段一个现实的字数区间，末尾的总账按各段实际相加的结果写。";
  }

  const where = LENGTH_SOURCE_LABELS[target.source];
  const range = describeLengthRange(target);

  if (stage === "angle") {
    return (
      `${where}是${range}。每个角度的「适合篇幅」都写在这个区间里` +
      `（比如「900 字左右，因为要交代一个反例」），` +
      "不要写比这个区间更大的数。材料撑不住这个量级就照实说缺什么，不要为了凑长度建议写长。"
    );
  }

  // 光说「落在这个数上」不够：模型照样会分八段、每段 200 字，加起来一千六。
  // 把段数和每段多少字直接摆给它，它才知道该分几段。
  const plan = planSectionCount(target);
  return (
    `${where}是${range}。大约分 ${plan.sections} 段，每段 ${plan.perMin}–${plan.perMax} 字，` +
    "各段的「篇幅」相加必须落在这个数上，末尾的总账按实际加总写，不要拍脑袋。"
  );
}
