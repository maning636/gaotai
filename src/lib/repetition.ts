/**
 * 重复检测与去重。
 *
 * 稿台自己会制造重复，来源有三个：
 *
 * 1. **补写**是「在已有内容后面接着加」，模型加完事实之后，
 *    常会顺手用一句话把本节的结论复述一遍；
 * 2. **全文写完之后**，那些结论句散落在各处，看起来像在反复说同一件事；
 * 3. **同一段原话被引两次**：开头引一次，展开时再引一次。
 *
 * 真模型成稿里的实例（`.tmp/real-run-8/article.md`）：
 * - 「省下的时间流向了别的地方」在全文出现 4 次；
 * - 「老工程师那句话给出的方向」出现 2 次；
 * - 「工作量本身没有减少」出现 2 次；
 * - 老工程师那段 27 字的原话被完整引用了 2 次；
 * - 末尾一整段把前面的论点又讲了一遍，还带一句超长的复述。
 *
 * 这一层只做机械判断，不猜语义：
 * - 逐字重复的句子一模一样，删掉后面那句不损失信息；
 * - 高度相似的句子说的是同一件事，一并删掉；
 * - 一句包着另一句（长句把短句裹在里面），把重复的那一段抽掉，
 *   两边的新信息都留着；
 * - 中度相似、整段短语重复、段落级相似只报不改，交给人判断。
 *
 * 删是机械操作，零模型调用——这也是它敢自动执行的原因：
 * 「同一句话说两遍」不需要再叫一次模型去改写。
 */

/** 一句话。 */
export type Sentence = {
  /** 句子正文（含末尾标点）。 */
  text: string;
  /** 归一化后的文本：只留汉字、字母和数字。 */
  normalized: string;
  /** 这一句有多少个汉字。 */
  han: number;
  /** 在原文里的起始位置。 */
  start: number;
  /** 在原文里的结束位置。 */
  end: number;
  /** 行号（1 起）。 */
  line: number;
  /**
   * 这一句在旁注里，不是正文。
   *
   * 「> 需核实（…）」那种括注是稿台自己标出来的事实缺口，
   * 它复述正文不算文章在绕圈，拿它当重复去改反而会把标注改坏。
   */
  aside: boolean;
};

/** 归一化：只留汉字、字母和数字，标点与空白一律去掉。 */
export function normalize(text: string): string {
  return text.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
}

/** 数汉字。 */
export function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

/** 字符二元组集合。中文没有词边界，二元组是最省事的近似。 */
function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) {
    set.add(text.slice(index, index + 2));
  }
  return set;
}

/** 两个二元组集合的交集大小。 */
function sharedCount(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const item of left) {
    if (right.has(item)) shared += 1;
  }
  return shared;
}

/**
 * 两段文字的相似度：字符二元组的 Jaccard。
 *
 * 取 0 到 1 之间。完全相同是 1，毫无关系是 0。
 *
 * Jaccard 有个天生的短板：它按「并集」算，一句长句里包着一句短句时，
 * 短句的那点内容被长句稀释掉，相似度就上不去。
 */
export function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  const shared = sharedCount(a, b);
  return shared / (a.size + b.size - shared);
}

/**
 * 包含度：短的那句是不是几乎全落在长的那句里。
 *
 * 分母取较短的那个，所以「长句包着短句」这种关系能看出来；
 * Jaccard 在这种关系上是瞎的。
 *
 * 真模型成稿里的实例：第 13 行「工作量本身没有减少。」是第 69 行
 * 「AI 编程助手改变的是工作内容的结构，工作量本身没有减少。」的一部分，
 * Jaccard 只有 0.33（看不出来），包含度是 1.00（一目了然）。
 */
export function containment(left: string, right: string): number {
  if (!left || !right) return 0;
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  return sharedCount(a, b) / Math.min(a.size, b.size);
}

/**
 * 归一化，同时记住每个字符在原文里的位置。
 *
 * 位置必须留住：重复的那一段要能定位回原句，才能从原句里抽掉。
 */
function normalizeWithPositions(text: string): { normalized: string; positions: number[] } {
  let normalized = "";
  const positions: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/[\u4e00-\u9fffA-Za-z0-9]/.test(char)) {
      normalized += char;
      positions.push(index);
    }
  }
  return { normalized, positions };
}

/**
 * 找重复片段用的归一化：被屏蔽的地方留下一个哨兵，而不是把它删掉。
 *
 * 早先的做法是按哨兵把正文切成一块一块，滑窗只在块内跑。
 * 那有个漏报：真模型成稿里那段 27 字的原话被引了两次，
 * 两处中间隔着一句配图说明，切成两块之后两处就不在同一个块里了，
 * 于是这处重复一次都没报出来。
 *
 * 现在改成：整篇归一化成一条串，被屏蔽的地方留一个哨兵字符。
 * 窗口里有哨兵就不算命中，延伸的时候也不许跨过哨兵——
 * 这样既能认出「这两处是同一段话」，又不会把
 * 「代码块里的字」和「正文里的字」凑成一段假的重复。
 */
function normalizeForPhraseScan(text: string): { normalized: string; positions: number[] } {
  const masked = maskNonProse(text);
  let normalized = "";
  const positions: number[] = [];
  let inMask = false;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "\u0001") {
      // 一整块被屏蔽的内容只留一个哨兵，
      // 别让它的长度把两处的距离撑大。
      if (!inMask) {
        inMask = true;
        normalized += "\u0001";
        positions.push(index);
      }
      continue;
    }
    inMask = false;
    if (/[\u4e00-\u9fffA-Za-z0-9]/.test(char)) {
      normalized += char;
      positions.push(index);
    }
  }
  return { normalized, positions };
}

/**
 * 屏蔽代码、网址、配图标记与机器元数据，但保持字符位置不变。
 *
 * 位置不能变：行号全靠它算。配图标记也要屏蔽——
 * 它是给人看的说明，不是正文，重复了不算问题。
 *
 * 被屏蔽的地方用哨兵字符标出来。哨兵把正文切成一段一段，
 * 滑窗只在段内进行——那几字本来就不相邻，凑在一起算重复是假的。
 */
function maskNonProse(text: string): string {
  const patterns: RegExp[] = [
    /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/,
    /```[\s\S]*?```/,
    /`[^`\n]*`/,
    /\[[^\]\n]{0,80}\]/g,
    /\]\([^\n)]*\)/,
    /https?:\/\/[^\s)>]+/,
    /<[^>\n]+>/,
  ];
  let masked = text;
  for (const pattern of patterns) {
    masked = masked.replace(pattern, hit => hit.replace(/[^\n]/g, "\u0001"));
  }
  return masked;
}

/** 行号表：位置 → 行号。 */
function buildLineIndex(text: string): number[] {
  const index = new Array<number>(text.length + 1);
  let line = 1;
  for (let position = 0; position <= text.length; position += 1) {
    index[position] = line;
    if (position < text.length && text[position] === "\n") line += 1;
  }
  return index;
}

/** 每行的起始位置，行号 → 该行开头。 */
function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/**
 * 短句不算重复。
 *
 * 「对。」「是啊。」这种短句重复出现是正常语气，
 * 拿它们当重复去报，只会满屏噪声。
 */
const MIN_SENTENCE_HAN = 8;

/**
 * 把正文切成句子。
 *
 * 断句只认句末标点与换行。中文的引号、括号里的内容不特殊处理——
 * 它们的内部本来也不该出现句号以外的断点。
 */
export function splitSentences(text: string): Sentence[] {
  const masked = maskNonProse(text);
  const lineIndex = buildLineIndex(text);
  const lineStarts = buildLineStarts(text);
  const sentences: Sentence[] = [];

  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed) {
      const normalized = normalize(trimmed);
      const han = hanCount(normalized);
      // 标题行不是正文，不参与重复判断。
      const isHeading = /^\s*#{1,6}\s/.test(raw);
      if (!isHeading && han >= MIN_SENTENCE_HAN) {
        const offset = start + raw.indexOf(trimmed);
        const line = lineIndex[Math.min(offset, text.length)] ?? 1;
        const lineStart = lineStarts[line - 1] ?? 0;
        sentences.push({
          text: trimmed,
          normalized,
          han,
          start: offset,
          end: offset + trimmed.length,
          line,
          // 旁注看的是它所在那一行，不看句子自己开头长什么样：
          // 「> 需核实（具体缺什么。是需求数量还是功能数？）」里的
          // 第二句开头是「是」，但它整个都在旁注里面。
          aside: /^\s*>/.test(text.slice(lineStart, lineStart + 4)),
        });
      }
    }
    start = end;
  };

  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "。" || char === "！" || char === "？" || char === "!" || char === "?" || char === "\n") {
      push(index + (char === "\n" ? 0 : 1));
    }
  }
  push(text.length);

  return sentences;
}

/** 一处重复。 */
export type Repetition = {
  level: "fail" | "warn";
  /** 重复的种类：逐字重复 / 高度相似 / 一句包着另一句 / 整段短语重复 / 段落级重复。 */
  kind: "exact" | "near" | "contain" | "phrase" | "paragraph";
  /** 给人和模型看的中文说明。 */
  message: string;
  /** 出问题那一处的行号。 */
  line: number;
  /** 原文片段。 */
  excerpt: string;
  /** 另一处的行号。 */
  otherLine?: number;
};

/** 逐字重复就报。 */
const EXACT_MIN_HAN = 8;
/** 相似到这个程度，说的是同一件事，可以自动删。 */
const NEAR_SIMILARITY = 0.72;
/** 相似到这个程度，值得提醒，但不该自动动。 */
const NEAR_WARN_SIMILARITY = 0.58;
/**
 * 一句包着另一句，到这个程度就当成重复。
 *
 * 实测（真模型成稿 + 测试夹具）：0.8 是干净的切分点——
 * 成稿上抓到 7 处真实重复，夹具上 0 误报。
 */
const CONTAINMENT_SIMILARITY = 0.8;
/**
 * 比较两句时，短的那句至少要这么多字。
 *
 * 九个字是「工作量本身没有减少」这种长度——
 * 少于九个字，碰巧撞上几个字就算包含，容易误伤。
 */
const CONTAINMENT_MIN_HAN = 9;
/** 连续这么多字一模一样，几乎不可能是巧合。 */
const PHRASE_LENGTH = 12;
/** 两处重复至少隔这么多个字才算两处，不然相邻窗口会互相撞上。 */
const MIN_PHRASE_DISTANCE = 40;
/** 段落级相似到这个程度，就是同一件事讲了两遍。 */
const PARAGRAPH_SIMILARITY = 0.3;

/** 位置对应的行号。 */
function lineAt(text: string, position: number): number {
  let line = 1;
  for (let index = 0; index < position && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/**
 * 找出稿子里的重复。
 *
 * 返回的每一项都带着行号与原文片段，界面能直接指给人看。
 */
export function findRepetitions(text: string): Repetition[] {
  const result: Repetition[] = [];
  if (!text || !text.trim()) return result;

  const sentences = splitSentences(text);

  // 1. 逐字重复：同一句一模一样的，归一化之后完全相同。
  const firstSeen = new Map<string, Sentence>();
  const exactPairs = new Set<string>();
  for (const sentence of sentences) {
    if (sentence.han < EXACT_MIN_HAN) continue;
    const seen = firstSeen.get(sentence.normalized);
    if (seen) {
      exactPairs.add(`${seen.start}:${sentence.start}`);
      result.push({
        level: "fail",
        kind: "exact",
        message: `同一句话重复出现，第 ${seen.line} 行和第 ${sentence.line} 行一模一样。`,
        line: sentence.line,
        excerpt: sentence.text.slice(0, 60),
        otherLine: seen.line,
      });
    } else {
      firstSeen.set(sentence.normalized, sentence);
    }
  }

  // 2. 高度相似：说的不是同一句话，但说的是同一件事。
  // 3. 包含：一句几乎是另一句里的一段（长句包着短句，Jaccard 在这里是瞎的）。
  for (let i = 0; i < sentences.length; i += 1) {
    for (let j = i + 1; j < sentences.length; j += 1) {
      const left = sentences[i];
      const right = sentences[j];
      if (exactPairs.has(`${left.start}:${right.start}`)) continue;

      // 近重复要两边都够长，相似度对短句不稳。
      // 这道门槛不能套在包含度上：包含度恰恰是给短句用的——
      // 「工作量本身没有减少」九个字，套上这道门槛就永远出不来。
      if (left.han >= 10 && right.han >= 10) {
        const score = similarity(left.normalized, right.normalized);
        if (score >= NEAR_WARN_SIMILARITY) {
          result.push({
            level: score >= NEAR_SIMILARITY ? "fail" : "warn",
            kind: "near",
            message:
              score >= NEAR_SIMILARITY
                ? `第 ${right.line} 行和第 ${left.line} 行说的是同一件事（相似度 ${score.toFixed(2)}）。`
                : `第 ${right.line} 行和第 ${left.line} 行很像（相似度 ${score.toFixed(2)}），人工看一下要不要留。`,
            line: right.line,
            excerpt: right.text.slice(0, 60),
            otherLine: left.line,
          });
          continue;
        }
      }

      if (left.han < CONTAINMENT_MIN_HAN || right.han < CONTAINMENT_MIN_HAN) continue;
      const contain = containment(left.normalized, right.normalized);
      if (contain < CONTAINMENT_SIMILARITY) continue;
      result.push({
        level: "warn",
        kind: "contain",
        message: `第 ${right.line} 行里有一整段（第 ${left.line} 行已经说过，重复度 ${contain.toFixed(2)}），人工看一下要不要删掉那段。`,
        line: right.line,
        excerpt: right.text.slice(0, 60),
        otherLine: left.line,
      });
    }
  }

  // 4. 整段短语重复：连续若干个字一模一样。
  // 逐字重复的句子已经被上面报过，这里报的是嵌在长句里的重复片段。
  // 这一档只提醒不拦路：长句里出现同一个短语未必是坏事，
  // 交给人看一眼比自己动刀稳妥。
  for (const item of findPhraseRepetitions(text)) {
    result.push(item);
  }

  // 5. 段落级重复：整段在讲另一段已经讲过的事。
  for (const pair of findParagraphRepetitions(text)) {
    result.push(pair);
  }

  return result.sort((a, b) => a.line - b.line);
}

/**
 * 找重复的整段短语。
 *
 * 早先的做法有个真 bug：滑窗一旦跨过标点就整窗丢掉，
 * 于是「写代码的时间省下来了，改代码的活儿一点没少」这种含逗号的重复片段
 * 一次都没报出来过——真模型成稿里那段 27 字的原话被引了两次，
 * 就是这样漏掉的。标点只是词与词之间的间隔，不是内容的分界。
 *
 * 现在整篇归一化成一条串（被屏蔽的地方留哨兵），
 * 滑窗在上面跑，位置由映射表还原。
 *
 * 命中之后要算「到底重复了多长」。办法是沿对角线前后都延伸：
 * 两处相距 gap 个字，那么第 i 个字和第 i+gap 个字逐个比对，
 * 连续相同的那一串就是重复的正文。往前延伸拿到重复段的开头，
 * 往后延伸拿到结尾。延伸不许跨过哨兵。
 *
 * 踩过的坑：**两处的坐标不能混用**。
 * 延伸的终点是「第二处」那边的坐标，拿它去切「第一处」的字符串，
 * 切出来的就是两处之间那整段正文——界面上会出现
 * 「这 960 个字在第 19 行和第 67 行各出现了一次」这种荒唐提示。
 * 所以重复片段的长度单独算，长度才拿去切第一处，
 * 而且切的是**原文**（带标点），不是归一化之后的那串字。
 */
function findPhraseRepetitions(text: string): Repetition[] {
  const result: Repetition[] = [];
  const { normalized, positions } = normalizeForPhraseScan(text);
  const size = normalized.length;
  if (size < PHRASE_LENGTH * 2) return result;

  // 每个窗口串在前面出现过几次。
  const seen = new Map<string, number[]>();
  // 命中：{ 第一处起点, 第二处起点, 重复长度 }，都是归一化坐标。
  const hits: Array<{ first: number; second: number; length: number }> = [];

  for (let index = 0; index + PHRASE_LENGTH <= size; index += 1) {
    const window = normalized.slice(index, index + PHRASE_LENGTH);
    // 窗口里有被屏蔽的内容：这串字不是连着写的，不算重复。
    if (window.includes("\u0001")) continue;
    const list = seen.get(window);
    if (!list) {
      seen.set(window, [index]);
      continue;
    }
    // 就近配对：离得最近的那一处，往往才是同一段重复。
    // 挨得太近的不算（原文里两个标点挨在一起就会归一化成同一串）。
    let paired = -1;
    for (let back = list.length - 1; back >= 0; back -= 1) {
      if (index - list[back] >= MIN_PHRASE_DISTANCE) {
        paired = list[back];
        break;
      }
    }
    if (paired < 0) {
      list.push(index);
      continue;
    }
    const gap = index - paired;
    // 往前延伸：重复段的开头。
    let start = index;
    while (
      start - gap - 1 >= 0 &&
      normalized[start - 1] !== "\u0001" &&
      normalized[start - 1] === normalized[start - 1 - gap]
    ) {
      start -= 1;
    }
    // 往后延伸：重复段的结尾。
    let end = index + PHRASE_LENGTH;
    while (
      end < size &&
      normalized[end] !== "\u0001" &&
      normalized[end] === normalized[end - gap]
    ) {
      end += 1;
    }
    hits.push({ first: start - gap, second: start, length: end - start });
    list.push(index);
  }

  // 同一段重复会被滑窗命中十几次。归堆合并，只报最长的那一段。
  const byStart = new Map<string, { first: number; second: number; length: number }>();
  for (const hit of hits) {
    const key = `${hit.first}:${hit.second}`;
    const known = byStart.get(key);
    if (!known || hit.length > known.length) byStart.set(key, hit);
  }

  // 同一处重复可能被不同的偏移量各报一次（同一段文字出现在三处以上）。
  // 第一处和第二处的区间都重叠的，只留最长的那一段。
  const regions = [...byStart.values()].sort((a, b) => b.length - a.length);
  const kept: Array<{ first: number; second: number; length: number }> = [];
  for (const region of regions) {
    const overlaps = kept.some(
      other =>
        region.first < other.first + other.length &&
        other.first < region.first + region.length &&
        region.second < other.second + other.length &&
        other.second < region.second + region.length,
    );
    if (!overlaps) kept.push(region);
  }

  for (const region of kept) {
    if (region.length < PHRASE_LENGTH) continue;
    if (region.first + region.length > size || region.second + region.length > size) continue;
    const line = lineAt(text, positions[region.second]);
    const otherLine = lineAt(text, positions[region.first]);
    if (line === otherLine) continue;
    // 片段切原文，带标点，人一眼能认出是哪句话。
    const rawStart = positions[region.first];
    const rawEnd = positions[region.first + region.length - 1] + 1;
    const span = text.slice(rawStart, rawEnd);
    const shown = span.length > 60 ? `${span.slice(0, 60)}…` : span;
    result.push({
      level: "warn",
      kind: "phrase",
      message: `「${shown}」这${region.length}个字在第 ${otherLine} 行和第 ${line} 行各出现了一次。`,
      line,
      excerpt: shown,
      otherLine,
    });
  }

  return result;
}

/** 一个段落。 */
type Block = { text: string; normalized: string; line: number };

/** 切出可识别的段落（跳过标题、列表、引用、代码）。 */
function proseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split(/\r?\n/);
  let lineNo = 0;
  let buffer: string[] = [];
  let startLine = 1;

  const flush = () => {
    const value = buffer.join("").trim();
    buffer = [];
    if (!value) return;
    const normalized = normalize(value);
    if (hanCount(normalized) < 20) return;
    blocks.push({ text: value, normalized, line: startLine });
  };

  for (const line of lines) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed) || /^(?:[-+*]|\d+[.、])\s/.test(trimmed) || trimmed.startsWith(">")) {
      flush();
      continue;
    }
    if (!buffer.length) startLine = lineNo;
    buffer.push(trimmed);
  }
  flush();

  return blocks;
}

/** 段落级的重复。 */
function findParagraphRepetitions(text: string): Repetition[] {
  const blocks = proseBlocks(text);
  const result: Repetition[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const score = similarity(blocks[i].normalized, blocks[j].normalized);
      if (score < PARAGRAPH_SIMILARITY) continue;
      result.push({
        level: "warn",
        kind: "paragraph",
        message: `第 ${blocks[j].line} 行这一段和第 ${blocks[i].line} 行讲的是同一件事（相似度 ${score.toFixed(2)}），人工看一下要不要留。`,
        line: blocks[j].line,
        excerpt: blocks[j].text.slice(0, 60),
        otherLine: blocks[i].line,
      });
    }
  }
  return result;
}

/** 去掉了一句。 */
export type RemovedSentence = {
  /** 行号（去重之前的行号）。 */
  line: number;
  /** 被去掉的那一句或那一段。 */
  text: string;
  /** 为什么被去掉。 */
  reason: string;
};

/** 去重的结果。 */
export type DedupeResult = {
  /** 去重后的正文。 */
  content: string;
  /** 去掉了几句。 */
  removed: RemovedSentence[];
};

/**
 * 机械去重。
 *
 * 分两步：
 *
 * 1. **删整句**：后面那句跟前面某句一模一样，或者说的是同一件事，
 *    就把后面那句删掉（第一次出现的那句留着，它是主句）。
 * 2. **抽片段**：后面那句里有一整段跟前面某句说过的一样，
 *    就把那一段从后面那句里抽掉——两边的新信息都留着。
 *    真模型成稿里的实例：第 13 行「工作量本身没有减少。」
 *    在第 69 行「AI 编程助手改变的是工作内容的结构，工作量本身没有减少。」里
 *    又说了一遍；把第 69 行里那半句抽掉，两句的信息都还在。
 *
 * 中度相似与段落级相似只报不改——那些地方模型是有意在回扣，
 * 替人做主删掉会误伤。
 */
export function dedupeRepeatedSentences(text: string): DedupeResult {
  const removed: RemovedSentence[] = [];

  // ---- 第一步：删整句 ----
  const sentences = splitSentences(text);
  const kept: Sentence[] = [];
  const dropRanges: Array<[number, number]> = [];

  for (const sentence of sentences) {
    let hit: Sentence | null = null;
    let reason = "";

    for (const previous of kept) {
      if (previous.normalized === sentence.normalized) {
        hit = previous;
        reason = `和第 ${previous.line} 行一模一样`;
        break;
      }
      if (previous.han < 10 || sentence.han < 10) continue;
      const score = similarity(previous.normalized, sentence.normalized);
      if (score >= NEAR_SIMILARITY) {
        hit = previous;
        reason = `和第 ${previous.line} 行说的是同一件事（相似度 ${score.toFixed(2)}）`;
        break;
      }
    }

    if (hit) {
      removed.push({ line: sentence.line, text: sentence.text, reason });
      dropRanges.push([sentence.start, eatTrailingPunctuation(text, sentence.end)]);
      continue;
    }
    kept.push(sentence);
  }

  let content = text;
  if (dropRanges.length) {
    content = applyDeletions(text, dropRanges);
  }

  // ---- 第二步：抽片段 ----
  for (let round = 0; round < 5; round += 1) {
    const fragment = extractRepeatedFragment(content);
    if (!fragment) break;
    content = applyDeletions(content, [[fragment.start, fragment.end]]);
    removed.push({
      line: fragment.line,
      text: fragment.text,
      reason: `和第 ${fragment.otherLine} 行说的是同一件事，重复的那一段已经抽掉`,
    });
  }

  if (!removed.length) return { content: text, removed: [] };

  // 删完之后可能出现空段，把空段收掉。
  content = content
    .split(/\n\s*\n/)
    .filter(block => block.trim().length > 0)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { content, removed };
}

/** 句子后面紧跟的标点也一起去掉，段落里不留空壳。 */
function eatTrailingPunctuation(text: string, end: number): number {
  let cursor = end;
  while (cursor < text.length && /[。！？!?，、；：]/.test(text[cursor])) cursor += 1;
  return cursor;
}

/** 按位置倒序删除，避免前面的删除影响后面的位置。 */
function applyDeletions(text: string, ranges: Array<[number, number]>): string {
  const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
  let content = text;
  for (const [start, end] of sorted) {
    content = content.slice(0, start) + content.slice(end);
  }
  return content;
}

/** 抽掉的那一段。 */
type Fragment = {
  /** 在全文里的删除区间。 */
  start: number;
  end: number;
  /** 抽掉的那段文字。 */
  text: string;
  /** 在第几行。 */
  line: number;
  /** 跟第几行重复。 */
  otherLine: number;
};

/**
 * 找出「一句包着另一句」里可以安全抽掉的那一段。
 *
 * 抽的是后面那句里、与前面某句重合的那一段。抽法有讲究：
 *
 * - 重复的那一段前后要有标点可依：后面跟着逗号就连逗号一起抽，
 *   前面挨着逗号就连逗号一起抽，抽完句子才读得顺；
 * - 抽的是引号里的引文：不抽。引文抽走以后那句往往就不成句了
 *   （「老工程师的原话是」后面空了），这种宁可留着让人看；
 * - 抽完剩下的部分不足十个字：整句删掉，留半句话比留重复更糟；
 * - 抽完剩下的部分以「是」「的」这种虚词结尾：整句删掉，
 *   那半句挂在别处读不通；
 * - 旁注（需核实那种括注）不抽，标注被改坏比留着重复更糟。
 */
function extractRepeatedFragment(text: string): Fragment | null {
  const sentences = splitSentences(text);

  let best: { fragment: Fragment; weight: number } | null = null;

  for (let i = 0; i < sentences.length; i += 1) {
    for (let j = i + 1; j < sentences.length; j += 1) {
      const earlier = sentences[i];
      const later = sentences[j];
      // 旁注是稿台自己插的标注，抽它比留着重复更糟。
      // 反过来也一样：标注本来就是照着正文生成的，
      // 正文里那句跟标注重合是标注的副产品，不是文章在绕圈，
      // 拿标注当依据去抽正文，会把正经内容抽掉。
      if (later.aside || earlier.aside) continue;
      if (earlier.han < CONTAINMENT_MIN_HAN || later.han < CONTAINMENT_MIN_HAN) continue;

      const contain = containment(earlier.normalized, later.normalized);
      if (contain < CONTAINMENT_SIMILARITY) continue;

      const span = commonSpan(earlier, later);
      if (!span) continue;

      const fragment = planFragmentDeletion(later, span, earlier.line);
      if (!fragment) continue;

      const weight = contain * 1000 + span.length;
      if (!best || weight > best.weight) best = { fragment, weight };
    }
  }

  return best?.fragment ?? null;
}

/**
 * 两句之间最长的那段公共文字。
 *
 * 走的是归一化之后的位置，所以抽出来的那一段能直接定位回原句里。
 *
 * 找的是**最长公共连续段**，两边可以错开对齐：
 * 「工作量本身没有减少」在「AI 编程助手改变的是工作内容的结构，工作量本身没有减少」
 * 里是错开 17 个字出现的，两边同下标去比，一个字都对不上。
 */
function commonSpan(
  earlier: Sentence,
  later: Sentence,
): { startInLater: number; length: number } | null {
  const left = earlier.normalized;
  const right = later.normalized;
  if (!left.length || !right.length) return null;

  // dp[j] = 以 earlier[j-1] 与 later[i-1] 结尾的公共串有多长。
  // 滚动一维即可。
  const dp = new Int32Array(left.length + 1);
  let best = 0;
  let bestEnd = 0;

  for (let i = 1; i <= right.length; i += 1) {
    for (let j = left.length; j >= 1; j -= 1) {
      dp[j] = right[i - 1] === left[j - 1] ? dp[j - 1] + 1 : 0;
      if (dp[j] > best) {
        best = dp[j];
        bestEnd = i;
      }
    }
    dp[0] = 0;
  }

  if (best < 6) return null;
  return { startInLater: bestEnd - best, length: best };
}

/**
 * 算出一段该怎么抽。
 *
 * 返回 null 表示这一处抽不得，交给人判断。
 */
function planFragmentDeletion(
  later: Sentence,
  span: { startInLater: number; length: number },
  otherLine: number,
): Fragment | null {
  const { positions } = normalizeWithPositions(later.text);
  const startInLater = span.startInLater;
  const endInLater = startInLater + span.length;
  if (endInLater > positions.length) return null;

  // 归一化位置 → 原句里的位置。
  const rawStart = positions[startInLater];
  const rawEnd = positions[endInLater - 1] + 1;

  // 引文不抽：抽走以后句子多半不成句。
  if (isInsideQuote(later.text, rawStart)) return null;

  const before = later.text.slice(0, rawStart).replace(/\s+$/, "");
  const after = later.text.slice(rawEnd);
  const beforeChar = before[before.length - 1] ?? "";
  const afterChar = after[0] ?? "";

  let cutStart = rawStart;
  let cutEnd = rawEnd;
  if (afterChar === "，" || afterChar === "、") {
    cutEnd = rawEnd + 1;
  } else if (beforeChar === "，" || beforeChar === "、") {
    cutStart = rawStart - 1;
  } else {
    // 两边都没有标点可依，抽完会粘成一句怪话。
    return null;
  }

  const rest = later.text.slice(0, cutStart) + later.text.slice(cutEnd);
  const restHan = hanCount(normalize(rest));
  // 抽完剩下的太少，这一整句就是那半句在撑着：整句删掉。
  if (restHan < MIN_SENTENCE_HAN) {
    return {
      start: later.start,
      end: eatTrailingPunctuation(later.text, later.end),
      text: later.text,
      line: later.line,
      otherLine,
    };
  }
  // 抽完剩下的以虚词收尾，那半句接不到别的地方：整句删掉。
  const tail = rest.replace(/[。！？!?，、；：\s]+$/, "").slice(-1);
  if ("是的了着过把被和与为在从向往跟对".includes(tail)) {
    return {
      start: later.start,
      end: eatTrailingPunctuation(later.text, later.end),
      text: later.text,
      line: later.line,
      otherLine,
    };
  }

  return {
    start: later.start + cutStart,
    end: later.start + cutEnd,
    text: later.text.slice(cutStart, cutEnd),
    line: later.line,
    otherLine,
  };
}

/** 这一段是不是在引号里面。 */
function isInsideQuote(text: string, position: number): boolean {
  const openers = ["「", "“", "『"];
  const closers = ["」", "”", "』"];
  for (let index = 0; index < openers.length; index += 1) {
    const openAt = text.lastIndexOf(openers[index], position);
    if (openAt < 0) continue;
    const closeAt = text.indexOf(closers[index], openAt + 1);
    // 还没闭合就说明位置在引号里面。
    if (closeAt < 0 || closeAt >= position) return true;
  }
  return false;
}
