import { chat, type ChatMessage } from "./llm";
import { countHan } from "./article-sections";
import type { OutlineParagraph } from "./length-target";

/**
 * 按节生成正文。
 *
 * 为什么长文不一次性生成：
 *
 * 真模型实测（2026-10-23，SenseNova 6.8-flash-lite）。
 * 用户要 3500 字的一次性写作请求，同一条请求连着跑了 4 次：
 * - 3 次一个字都没交出来（额度全被思考吃光，每次约 2 分钟）；
 * - 1 次交出 2066 字——正好是上一稿的 2068 字，
 *   也就是说模型是照着上下文里旧稿的长度写的，让它写 3500 它就写 2000。
 *
 * 也就是说，一次性写长文有两个毛病：**不稳**（有时一个字都没有）
 * 和**长度对不上**（写多少不由人定，由上下文里的旧稿定）。
 * 这两条都不是提示词能救的——提示词里逐节的字数账写得清清楚楚，
 * 模型照样只写 2066 字。
 *
 * 按节生成把这两个毛病一起解决：
 * - 每一节只写三五百字，输出小、思考没有空间乱跑，请求交得出正文；
 * - 每一节有自己独立的字数账，说「控制在 360 字上下」实测能命中
 *   （补写路径已经验证过：说 209 字它交 210 字）；
 * - 各节互不相干，可以并发，整体耗时是串行的三分之一。
 *
 * 代价是各节之间没有上下文。所以每一节的请求都带上：
 * 全文的结构（每一节要干什么）、本节的要求、本节要用的事实、
 * 以及上一节要干什么（用来接语气，不是接原句）。
 */

/**
 * 一次分节写作给多少额度。
 *
 * 每一节只写几百字，8192 绰绰有余。
 * 额度给小了思考会把正文挤掉——补写路径实测过：
 * 4096 时思考吃满额度、正文一个字没有，8192 时思考花 3005、正文照常交出。
 */
export const SECTION_WRITE_MAX_TOKENS = 8192;

/**
 * 同时写几节。
 *
 * 各节之间互不相干，可以并发。但服务商有 TPM/RPM 限制，
 * 并发开太大容易撞 429（撞了 llm 层会退避，不会出错）。
 */
export const SECTION_WRITE_CONCURRENCY = 3;

/** 一节的施工单。 */
export type SectionPlan = {
  /** 大纲里对应的那一段。 */
  paragraph: OutlineParagraph;
  /** 这一节写多少字。 */
  target: number;
};

/**
 * 把大纲段落配成一份分节施工单。
 *
 * 大纲里没写字数账的那几段，按全文目标平分——
 * 每一节都得有个目标数字，不然模型不知道该写多少，
 * 「写足它自己的判断」在实践里等于「随便写」。
 */
export function planSectionWriting(args: {
  paragraphs: OutlineParagraph[];
  /** 全文的字数目标。0 表示不知道。 */
  totalTarget: number;
}): SectionPlan[] {
  const paragraphs = args.paragraphs.filter(item => item.label.trim());
  if (!paragraphs.length) return [];

  const share =
    args.totalTarget > 0 ? Math.round(args.totalTarget / paragraphs.length) : 0;

  return paragraphs.map(item => {
    if (item.min > 0) {
      // 账是一个区间，取中间值当目标：写低了补写要再跑一趟，写高了闸门会拦。
      const target = Math.round((item.min + (item.max || item.min)) / 2);
      return { paragraph: item, target };
    }
    return { paragraph: item, target: share };
  });
}

/**
 * 拼「写一节」的对话。
 *
 * 这个提示词是照着真模型的脾气写的，几条都是实测出来的：
 *
 * 1. **给结构、给本节的要求、给字数，不给整篇大纲的施工说明。**
 *    把「目的/内容/素材/形式」全套要求塞进请求，模型会去逐条核对，
 *    额度全花在思考上，正文一个字没有（真模型实测，六次补写有五次空）。
 *    这里只给本节的那一份，外加一份紧凑的结构清单当上下文。
 * 2. **字数说「控制在 N 字上下」。** 说「大约 N 字」它会失控，
 *    说「控制在 N 字上下」实测正好命中。
 * 3. **上一节只给要求，不给正文。** 给了正文模型就会照着改写，
 *    各节会长得一模一样（那正是我们要消灭的重复）。
 * 4. **硬规则写成一条。** 规则列得越全，模型花在校对上的思考越多。
 */
export function buildSectionWriteMessages(args: {
  /** 这一节的施工单。 */
  plan: SectionPlan;
  /** 这一节是第几节（从 0 起）。 */
  index: number;
  /** 一共几节。 */
  total: number;
  /** 全部段落，用来给结构上下文。 */
  outline: OutlineParagraph[];
  /** 可以用的事实清单。 */
  facts?: string;
  /** 上一节的施工单。第一节没有。 */
  previous?: OutlineParagraph;
  /** 写作方法（技能包正文）。没有就不给。 */
  guidance?: string;
  /** 这篇稿子是谁在说话。 */
  voice?: string;
}): ChatMessage[] {
  const { plan, index, total, outline, facts, previous, guidance, voice } = args;
  const paragraph = plan.paragraph;

  // 一段必须有一句能执行的任务。
  // 大纲解析不出来的时候（模型把大纲写成散文、或者只给了一句段名），
  // 提示词里就会出现「这一段的目的：」后面什么都没有——
  // 模型拿到一个没有任务的请求，就陷进逐条猜的思考里，
  // 额度全被思考吃光，正文一个字都交不出来（真模型实测：
  // finish_reason=length，reasoning_tokens=8192，content 空，160 秒）。
  // 所以这里兜底：目的为空就用内容，再不行就用段名。
  const purposeOf = (item: OutlineParagraph): string =>
    (item.purpose || item.content || item.label || "").trim();

  // 结构清单里每一段都要带推进：这是各节串成一条线的唯一依据。
  // 只给「目的」的话，各节之间看不出先后关系，模型写出来就是一排并列的小节。
  const structure = outline
    .map(
      (item, i) =>
        `${i + 1}. ${item.label.replace(/[（(][^）)]*[）)]\s*$/, "").trim()}：${
          item.advance ? `${item.advance}（${purposeOf(item)}）` : purposeOf(item)
        }`,
    )
    .join("\n");

  const lines: string[] = [];
  lines.push("这篇文章的结构：");
  lines.push(structure);
  lines.push("");
  lines.push(
    `你现在写第 ${index + 1} 段（${paragraph.label.replace(/[（(][^）)]*[）)]\s*$/, "").trim()}），全文一共 ${total} 段。`,
  );
  lines.push("");
  // 推进是这一段最要紧的一句：它决定这一节要让读者的理解往哪儿挪。
  // 目的说的是「要读者接受什么」，推进说的是「挪到哪儿去」——
  // 后者才是让各节串成一条线而不是并排几堆的东西。
  if (paragraph.advance) {
    lines.push(`这一段在推进线上要做的事：${paragraph.advance}`);
  }
  lines.push(`这一段的目的：${purposeOf(paragraph)}`);
  if (paragraph.content) lines.push(`这一段要写的内容：${paragraph.content}`);
  if (paragraph.material) lines.push(`这一段要用的素材：${paragraph.material}`);
  if (paragraph.format) lines.push(`这一段的写法：${paragraph.format}`);
  lines.push("");
  lines.push(`这一段控制在 ${plan.target} 字上下。`);
  lines.push("");

  if (previous) {
    const prevLabel = previous.label.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
    lines.push(`上一段（第 ${index} 段·${prevLabel}）已经讲完：${purposeOf(previous)}`);
    lines.push("这一段接着往前推进，不要重复上一段讲过的内容，也不要重复前面任何一段说过的判断。");
    lines.push("");
  }

  if (facts) {
    lines.push("可以用的材料事实：");
    lines.push(facts);
    lines.push("");
  }

  // 谁在说。分节生成时每一节是独立请求，
  // 不带这个的话每节都会自己挑一个语气，拼起来像几个人写的。
  if (voice && voice.trim()) {
    lines.push("这篇稿子是谁在说话：");
    lines.push(voice.trim());
    lines.push("用这个人的口气写这一段。");
    lines.push("");
  }

  if (index === 0) {
    lines.push("直接写正文，不要小标题。第一段就要让读者知道这篇文章想说什么。");
  } else {
    lines.push("先给一个 `##` 小标题（写这一节的具体观点，不要写套话），再写正文。");
  }
  lines.push("");

  if (paragraph.material && /需补|需核实/.test(paragraph.material)) {
    lines.push("材料里没有的那部分，写成 `> 需核实（<具体缺什么>）`，不要自己编。");
    lines.push("");
  }

  lines.push("写这一段时：");
  lines.push("- 这一段必须让读者的理解往前走一步。写完回头看，读者对这件事的看法要跟读之前不一样。");
  lines.push("- 和上一段之间要有因果，能用「所以」「但是」连起来。连不上就是两堆并列的东西。");
  lines.push("- 判断直接从正面说，不用中文冒号，不用破折号。");
  lines.push("- 一段一个意思，最多 3 行。");
  lines.push("- 不要复述前面几段讲过的判断，也不要在结尾写总结句。");
  lines.push("- 只交这一段的正文（小标题放第一行），不要解释，不要写「好的」这类开场白。");

  const system = [
    "你是中文长文作者，正在写一篇公众号文章的一节。",
    guidance ? guidance.trim() : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
}

/** 一节写完的结果。 */
export type SectionWriteOutcome = {
  /** 小标题。第一节没有小标题，是空串。 */
  heading: string;
  /** 这一节的正文，不含小标题。 */
  body: string;
  /** 这一节的汉字数。 */
  hanCount: number;
  /** 失败原因。 */
  error?: string;
};

/**
 * 把模型交回来的东西拆成小标题和正文。
 *
 * 模型有时候不听指挥，直接把正文交回来（没有小标题），
 * 有时候先写一句「好的，我来写第 3 段」。这些都要处理掉：
 * 拼进正文里的每一行都要是读者能看到的正文。
 */
export function splitSectionOutput(raw: string, index: number): { heading: string; body: string } {
  let text = raw.trim();
  // 去掉「好的」「下面是」这类引导语。
  text = text.replace(/^(好的[，,。！!]?|下面是[^。\n]{0,20}[。\n])+/g, "").trim();

  let heading = "";
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  const headingMatch = /^#{2,}\s*(.+)$/.exec(first);
  if (headingMatch) {
    heading = headingMatch[1].trim();
    lines.shift();
    text = lines.join("\n").trim();
  } else if (index === 0) {
    // 第一节不要小标题，模型自己加了就当正文处理（多半是误加）。
    text = text.replace(/^#{1,3}\s*.*\n+/, "").trim();
  }

  // 模型偶尔在正文里用 ### 分点，正文里不应该出现。
  text = text.replace(/^#{3,}\s*/gm, "").trim();

  return { heading, body: text };
}

/**
 * 写一节。
 *
 * 额度给 8192、思考强度给 none：
 * 每一节的输出只有几百字，思考没有空间乱跑，
 * 而一旦模型陷进逐条核对的思考，额度会被吃光、正文一个字都没有。
 */
export async function writeSection(args: {
  plan: SectionPlan;
  index: number;
  total: number;
  outline: OutlineParagraph[];
  facts?: string;
  previous?: OutlineParagraph;
  guidance?: string;
  /** 这篇稿子是谁在说话。 */
  voice?: string;
  timeoutMs?: number;
}): Promise<SectionWriteOutcome> {
  const messages = buildSectionWriteMessages(args);
  try {
    const result = await chat({
      messages,
      maxTokens: SECTION_WRITE_MAX_TOKENS,
      reasoningEffort: "none",
      label: "分节生成",
      timeoutMs: args.timeoutMs ?? 240_000,
    });
    const { heading, body } = splitSectionOutput(result.content, args.index);
    if (!body) {
      return { heading, body: "", hanCount: 0, error: "模型这一节没有交出正文。" };
    }
    const hanCount = countHan(body);
    if (hanCount < 30) {
      return {
        heading,
        body,
        hanCount,
        error: `这一节只写出来 ${hanCount} 字，太少，等于没写。`,
      };
    }
    return { heading, body, hanCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { heading: "", body: "", hanCount: 0, error: message };
  }
}

/** 分节生成的整体结果。 */
export type SectionWriteResult = {
  /** 拼好的正文。 */
  content: string;
  /** 写成了几节。 */
  written: number;
  /** 一共几节。 */
  total: number;
  /** 逐节说明。 */
  notes: string[];
  /** 没写成的节。 */
  failed: number;
};

/**
 * 固定几个工人一起写。
 *
 * 单线程里 `cursor += 1` 不会真的并发执行，
 * 但它保证每个活只被领走一次——这正是这里需要的。
 */
async function runConcurrently<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  if (!size) return;
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * 按节把整篇文章写出来。
 *
 * 写成的节按大纲顺序拼回去：第一节是开头（没有小标题），
 * 从第二节起每节前面加 `##` 小标题。这一层拼出来的结构
 * 和大纲的段数一一对应，后面的按节补写才能对上号。
 */
export async function writeArticleBySections(args: {
  plans: SectionPlan[];
  outline: OutlineParagraph[];
  facts?: string;
  guidance?: string;
  /** 这篇稿子是谁在说话。 */
  voice?: string;
  concurrency?: number;
  timeoutMs?: number;
}): Promise<SectionWriteResult> {
  const notes: string[] = [];
  const written: Array<{ heading: string; body: string; hanCount: number } | null> =
    new Array(args.plans.length).fill(null);
  let failed = 0;

  // 各节之间互不相干，可以并发；每节自己带序号回来，拼的时候才知道谁是谁。
  await runConcurrently(
    args.plans.map((plan, index) => ({ plan, index })),
    args.concurrency ?? SECTION_WRITE_CONCURRENCY,
    async job => {
      const outcome = await writeSection({
        plan: job.plan,
        index: job.index,
        total: args.plans.length,
        outline: args.outline,
        facts: args.facts,
        previous: job.index > 0 ? args.plans[job.index - 1].paragraph : undefined,
        guidance: args.guidance,
        voice: args.voice,
        timeoutMs: args.timeoutMs,
      });
      if (outcome.error || !outcome.body) {
        failed += 1;
        notes.push(`${job.plan.paragraph.label}：没写出来（${outcome.error ?? "未知原因"}）。`);
        return;
      }
      written[job.index] = {
        heading: outcome.heading,
        body: outcome.body,
        hanCount: outcome.hanCount,
      };
      notes.push(`${job.plan.paragraph.label}：写了 ${outcome.hanCount} 字。`);
    },
  );

  // 拼回正文。没写成的节留空，不要拿别的节顶替——
  // 顶替会让字数账和段落顺序一起错位。
  const parts: string[] = [];
  args.plans.forEach((plan, index) => {
    const item = written[index];
    if (!item) return;
    const heading = index === 0 ? "" : item.heading || fallbackHeading(plan.paragraph);
    parts.push(heading ? `## ${heading}\n\n${item.body}` : item.body);
  });

  const content = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();

  return {
    content,
    written: written.filter(Boolean).length,
    total: args.plans.length,
    notes,
    failed,
  };
}

/**
 * 模型没给小标题时，用大纲里的角色名兜底。
 *
 * 「第 2 段·立论」去掉编号就是「立论」，
 * 至少比没有小标题强——没有小标题，这一节在正文里就找不到了。
 */
export function fallbackHeading(paragraph: OutlineParagraph): string {
  const cleaned = paragraph.label
    .replace(/^第\s*\d+\s*段[·・:：\s]*/, "")
    .replace(/[（(][^）)]*[）)]\s*$/, "")
    .trim();
  return cleaned || "正文";
}
