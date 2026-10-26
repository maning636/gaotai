/**
 * 正文的小节结构。
 *
 * 大纲给的是「第 N 段」，正文给的是 `##` 小节。
 * 两边对得上的时候，字数账才能落到具体某一节上——
 * 对不上，按账补写就会补错地方，模型补得越多偏得越远。
 *
 * 所以这一层只做两件事：把正文切开，把切开的部分原样拼回去。
 * 切的时候不动一个字，拼的时候也不动一个字，
 * 中间只允许改「某一节的正文」，标题和段落顺序都保持原样。
 */

/** 正文里的一个小节。 */
export type ArticleSection = {
  /** 小标题文字。开头那段没有小标题，是空串。 */
  heading: string;
  /** 小节正文，不含标题行。 */
  body: string;
  /** 这一节的汉字数。 */
  hanCount: number;
  /** 这一节在原文里的起始行号（1 起）。 */
  startLine: number;
  /** 这一节在原文里的结束行号（1 起，含）。 */
  endLine: number;
};

/** 数汉字。字数目标、闸门、体检都用这一个口径。 */
export function countHan(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

/**
 * 小标题行。`##` 和 `###` 都算小节边界。
 *
 * 真模型实测（2026-10-22）：提示词写的是「小节 `##`，子小节 `###`」，
 * 模型把文章标题写成 `##`，把正文各段写成 `###`——
 * 只认 `##` 的话，八段正文会被当成一节，逐节补写整个对不上号。
 * 宁可把层级放宽，也不要把正文压成一坨。
 */
const HEADING_RE = /^(#{2,})\s+(.*)$/;

/**
 * 把正文切成小节。
 *
 * 第一个小标题之前的那一段也算一节（heading 为空）——
 * 开头的主张、引子都写在那里，它同样要占大纲第一段的字数。
 */
export function splitArticleSections(content: string): ArticleSection[] {
  const sections: ArticleSection[] = [];
  let heading = "";
  let buffer: string[] = [];
  let started = false;
  let startLine = 1;
  let lineNo = 0;

  const flush = (endLine: number) => {
    if (!started && !buffer.some(line => line.trim())) return;
    const body = buffer.join("\n");
    sections.push({ heading, body, hanCount: countHan(body), startLine, endLine });
    buffer = [];
  };

  for (const line of content.split(/\r?\n/)) {
    lineNo += 1;
    const match = HEADING_RE.exec(line);
    if (match) {
      flush(lineNo - 1);
      heading = match[2].trim();
      started = true;
      startLine = lineNo + 1;
      continue;
    }
    buffer.push(line);
  }
  flush(lineNo);

  return sections;
}

/**
 * 把小节拼回正文。
 *
 * 拼回去的格式要跟切出来的一样，不然补写过的稿子一眼就能看出接缝。
 */
export function joinArticleSections(sections: ArticleSection[]): string {
  return sections
    .map(section =>
      section.heading
        ? `## ${section.heading}\n\n${section.body.trim()}`
        : section.body.trim(),
    )
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 一节差多少字。
 *
 * 只统计「差得值得补」的那几节：差两个字不算短，
 * 为两个字单独叫一次模型不划算，补进去的字还可能是注水。
 */
export type SectionDeficit = {
  /** 正文里的第几节（从 0 起）。 */
  index: number;
  /** 这一节的小标题。 */
  heading: string;
  /** 现在多少字。 */
  current: number;
  /** 目标字数。 */
  target: number;
  /** 还差多少字。 */
  missing: number;
};

/** 差得不足这个比例就算「够着」，不单独补。 */
const DEFICIT_RATIO = 0.95;
/** 差得不足这么多字也不单独补。 */
const DEFICIT_FLOOR = 30;

/**
 * 把正文的小节和大纲的段落对上号，再算出哪几节短了。
 *
 * 对不上的情况很常见：模型会自己加小节，也会把两段并成一节。
 * 这时候不该硬补——按错误的对应关系补写，只会让稿子更偏。
 * 对不上就返回 aligned=false，交给整篇补写或者如实报告缺口。
 */
export function planSectionExpansion(
  sections: ArticleSection[],
  budgets: Array<{ min: number; max: number }>,
): { aligned: boolean; deficits: SectionDeficit[] } {
  if (!sections.length || !budgets.length) return { aligned: false, deficits: [] };
  if (sections.length !== budgets.length) return { aligned: false, deficits: [] };

  const deficits: SectionDeficit[] = [];
  sections.forEach((section, index) => {
    const budget = budgets[index];
    const target = budget.min;
    if (!target) return;
    if (section.hanCount >= target * DEFICIT_RATIO) return;
    const missing = target - section.hanCount;
    if (missing < DEFICIT_FLOOR) return;
    deficits.push({
      index,
      heading: section.heading,
      current: section.hanCount,
      target,
      missing,
    });
  });

  return { aligned: true, deficits };
}

/**
 * 对不上号时的退路：按平均份额补。
 *
 * 模型常常会自己多写一节、少写一节，这时候正文的小节数和大纲的段落数对不上，
 * 按序号对应就会补错地方。但「全文要写多少字」这个目标还在，
 * 那就按平均份额算每一节该有多少字，短的那些节补上去。
 *
 * 这个办法不如按大纲对号准（它不知道哪一节本来就该重），
 * 但它不会补错地方——补的都是短节，方向是对的。
 */
export function planSectionExpansionByShare(
  sections: ArticleSection[],
  totalTarget: number,
): { aligned: boolean; deficits: SectionDeficit[] } {
  if (!sections.length || totalTarget <= 0) return { aligned: false, deficits: [] };
  const share = totalTarget / sections.length;

  const deficits: SectionDeficit[] = [];
  sections.forEach((section, index) => {
    if (section.hanCount >= share * DEFICIT_RATIO) return;
    const missing = Math.round(share) - section.hanCount;
    if (missing < DEFICIT_FLOOR) return;
    deficits.push({
      index,
      heading: section.heading,
      current: section.hanCount,
      target: Math.round(share),
      missing,
    });
  });

  return { aligned: true, deficits };
}
