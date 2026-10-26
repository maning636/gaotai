import type { OutlineParagraph } from "./length-target";

/**
 * 大纲要点覆盖检查。
 *
 * 这才是「这篇写完了没有」的真正口径。
 *
 * 字数不是合格线：材料撑得起就写实，撑不起就写短，写短是合法的。
 * 大纲上规划过的内容有没有落地才是——
 * 读者按大纲的预期读，正文里该有的那几段却在，那是真漏了。
 *
 * 这一层刻意做成**纯机械**的：
 * - 不调模型（一次模型调用就能把稿子改坏，见 article-review.ts 里的实测记录）；
 * - 只提示，不拦路（差多少字、漏了哪一点，摆出来由人决定）。
 *
 * 判据用「关键词命中率」，不是语义相似度——语义要判断力，机械层没有。
 * 所以它宁可漏报也不误报：命中不了不代表没写，只是机器认不出来。
 */

/** 一次覆盖检查的结果。 */
export type OutlineCoverage = {
  /** 大纲一共规划了几段。 */
  total: number;
  /** 判定为「写到了」的段数。 */
  covered: number;
  /** 没写到的段的标签。 */
  missing: string[];
};

/**
 * 从一段大纲里抽出该被写到正文的锚点。
 *
 * 只认两类：**数字**和**英文词**。
 *
 * 为什么只认这两类：数字和英文词在正文里几乎会原样出现（800、1.29、Kubernetes），
 * 大纲写了、正文没有，基本就是真漏了。而纯中文措辞在正文里必然换一种说法
 * （大纲写「评审变慢」，正文写「评审那部分卡得更久」），拿它当判据会大量误报。
 * 误报比漏报更糟——用户会照着提示去改一篇其实没问题的稿子。
 *
 * 所以抽不出锚点的段（比如只写「引入问题」）不参与判定：
 * 没有可核对的锚点，机器判了也是瞎判。
 */
function keywordsOf(paragraph: OutlineParagraph): string[] {
  const source = [paragraph.advance, paragraph.content, paragraph.material, paragraph.purpose]
    .filter(Boolean)
    .join(" ")
    // 「（材料第 3 段）」里的段号不是要写进正文的内容，
    // 留着它等于给每一段发一个「3」——正文里随便哪个数字都能命中，等于没判。
    .replace(/材料?第\s*\d+\s*段/g, " ");

  const words: string[] = [];

  // 数字（带单位的也算）：800、30%、1.29。
  for (const hit of source.match(/\d+(?:\.\d+)?%?/g) ?? []) {
    words.push(hit);
  }

  // 英文词：Docker、TypeScript、Kubernetes。
  for (const hit of source.match(/[A-Za-z][A-Za-z0-9_+.#-]{1,}/g) ?? []) {
    words.push(hit.toLowerCase());
  }

  return [...new Set(words)];
}

/**
 * 算一份正文覆盖了大纲的多少。
 *
 * 段与段的对应关系是按顺序对上的：正文第 N 节对应大纲第 N 段。
 * 正文小节比大纲多（模型自己加了一节）或少，都按能对上的部分算。
 */
export function checkOutlineCoverage(
  paragraphs: OutlineParagraph[],
  content: string,
): OutlineCoverage {
  const usable = paragraphs.filter(item => item.label.trim());
  if (!usable.length) return { total: 0, covered: 0, missing: [] };

  const body = content.toLowerCase();
  const sections = splitSections(body);

  let covered = 0;
  const missing: string[] = [];

  usable.forEach((paragraph, index) => {
    const words = keywordsOf(paragraph);
    // 对应的那一节正文。段数对不上时，对不上的段就不判（宁可漏报）。
    const section = sections[index] ?? "";
    const haystack = section || body;

    if (!words.length) {
      // 没有锚点可核，视为写到了——不凭猜测定罪。
      covered += 1;
      return;
    }

    // 命中一个关键词就算写到了。
    //
    // 为什么只要一个：这一段的目的可能很宽（"讲清楚为什么慢"），
    // 正文里的说法又必然跟大纲措辞不同。要求全中会把大量写到了的段落误判成漏写，
    // 那比漏报更糟——用户会照着提示去改一篇其实没问题的稿子。
    const hit = words.some(word => haystack.includes(word));
    if (hit) {
      covered += 1;
      return;
    }
    missing.push(paragraph.label.replace(/[（(][^）)]*[）)]\s*$/, "").trim());
  });

  return { total: usable.length, covered, missing };
}

/**
 * 把正文切成小节。
 *
 * 与 article-sections.ts 的切法一致（`##` 以上都是小节标题），
 * 但这里要自己切一份：这一层不能依赖正文改写那条链，
 * 也不需要每节的小标题文字，只要每节的正文。
 */
function splitSections(body: string): string[] {
  const sections: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    sections.push(buffer.join("\n"));
    buffer = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^#{2,}\s+/.test(line)) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return sections;
}
