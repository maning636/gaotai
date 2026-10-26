import { readAgentConfig } from "./agent-config-store";
import { STAGE_LABELS, type Stage, type StageResultRow } from "./db";
import { chat, chatWithTools, drainLlmTimings, type ChatMessage } from "./llm";
import { getPrompt, renderPrompt } from "./prompt-store";
import { type ProseFinding } from "./prose-check";
import { appendMessage, getProject, listMessages, listStageResults, saveStageResult } from "./repo";
import { openSkills, renderSkillCatalog, type SkillCatalog } from "./skills";
import {
  DEFAULT_ARTICLE_LENGTH,
  LENGTH_SOURCE_LABELS,
  fitParagraphsToTarget,
  parseOutlineParagraphs,
  renderLengthInstruction,
  resolveLengthTarget,
  stageOutputBudget,
  type LengthTarget,
} from "./length-target";
import { reportArticle } from "./article-review";
import { checkOutlineCoverage } from "./outline-coverage";
import { planSectionWriting, writeArticleBySections } from "./section-writer";

/**
 * 阶段引擎。
 *
 * 一篇稿子要走四道工序：材料解读 → 选题与方向 → 写作大纲 → 文章正文。
 * 每道工序都是「AI 出稿 → 用户追问 → 用户签字」的三段式，签字之后产出才算定稿，
 * 下一道工序才拿得到它。
 *
 * 这里只做两件事：把上下文拼成消息、把结果落库。
 * 拼装的顺序是有讲究的：
 *   全局要求 → 本阶段要求 → 专题规则 → 作者风格 → 前序定稿 → 对话历史 → 本次输入
 * 越靠前越稳定（用户改得少），越靠后越具体（每次都不一样）。
 */

export type StageRunInput = {
  projectId: string;
  stage: Stage;
  /** 用户的素材或追问。 */
  userInput: string;
  /** 专题规则原文，由调用方从专题模块取得——引擎不自己读专题，保持职责单一。 */
  topicRules?: string;
  topicName?: string;
  /** 作者风格画像（markdown）。 */
  styleProfile?: string;
  /** 正文阶段启用的技能包 id。只有正文阶段会用，其它阶段忽略。 */
  skills?: string[];
  /**
   * 界面上手填的字数目标（「1000」「800-1200」）。
   *
   * 它比输入框里的字更明确，所以优先级最高。
   * 没有它的时候，稿台按默认篇幅走（公众号是短文，见 DEFAULT_ARTICLE_LENGTH）。
   */
  lengthTarget?: string;
};

export type StageRunResult = {
  content: string;
  stageResult: StageResultRow;
  messages: ChatMessage[];
  /**
   * 技能这一环没生效时的说明。
   *
   * 有它是因为「模型没读技能包」和「正文写得好不好」是两件事：
   * 稿子照样能出，但不能让人以为它是按技能写的。
   */
  skillWarning?: string;
  /**
   * 模型返回时的结束原因。
   *
   * 值为 length 表示输出被 max_tokens 截断——稿子可能只有半截，
   * 但界面上看不出区别（文字是连贯的，只是没写完）。把它带出去，
   * 用户才知道这篇是半截的，可以调大额度重来。
   */
  finishReason?: string;
  /**
   * 正文阶段的成稿体检结果与字数。
   *
   * 服务端用同一把尺子量过一遍才交稿，所以这个数字是可信的：
   * 字数就是正文里的汉字数，硬禁令条数就是真的命中条数。
   */
  quality?: ArticleQuality;
  /**
   * 这一阶段各步骤花了多久。
   *
   * 写一篇长文动辄十几分钟，界面上只有一个转圈的圈，
   * 用户不知道慢在生成还是慢在补写。把每一步的耗时摊开，
   * 慢在哪里一眼就看见。
   */
  timings?: StageTiming[];
};

/** 一个步骤的耗时。 */
export type StageTiming = {
  /** 这一步叫什么：生成、按句改写、按节补写。 */
  label: string;
  /** 这一步花了多少毫秒。 */
  ms: number;
  /** 这一步发了几次模型请求。 */
  calls: number;
};

/**
 * 收走这一段时间里的模型请求计时，归成一步。
 *
 * llm 层把每次请求的耗时都记着，这里按步骤切段。
 */
function collectTimings(label: string): StageTiming {
  const items = drainLlmTimings();
  return {
    label,
    ms: items.reduce((sum, item) => sum + item.ms, 0),
    calls: items.length,
  };
}

/** 正文阶段的成稿体检摘要。 */
export type ArticleQuality = {
  /** 正文汉字数。 */
  hanCount: number;
  /** 硬禁令条数。 */
  failCount: number;
  /** 需要人工判断的条数。 */
  warnCount: number;
  /** 距目标下限还差多少字。 */
  missing: number;
  /** 字数目标。 */
  target: { min: number; max: number; source: string; sourceLabel: string; raw: string } | null;
  /** 逐条体检结果。 */
  findings: ProseFinding[];
  /**
   * 大纲要点覆盖。
   *
   * 这是新的合格线：不是字数够不够，是大纲上要的每一点有没有落地。
   * 只提示不拦路。
   */
  coverage?: { covered: number; total: number; missing: string[] };
  /** 自动补写／改写的逐条说明，界面要如实显示。 */
  notes?: string[];
};

/** 阶段顺序，用于决定「前序阶段产出」的排列。 */
const STAGE_ORDER: Stage[] = ["brief", "angle", "outline", "article"];

function section(title: string, body: string): string {
  const trimmed = body.trim();
  return trimmed ? `## ${title}\n\n${trimmed}` : "";
}

/**
 * 取出已经签字的前序阶段产出。
 *
 * 只有 confirmed 的才注入：草稿阶段的产出用户还在改，
 * 拿它当既定事实往下推，后面全歪。
 *
 * **正文阶段只取骨架，不取全文。**
 *
 * 真模型实测（2026-10-23 03:00）：材料解读 2269 字 + 选题 2288 字 + 大纲 1788 字
 * 全灌进正文阶段，请求上下文 25KB，而交付物才 900 字（1.8KB）——
 * 上下文是交付物的 14 倍。后果是模型陷进长上下文的思考里，
 * 8192 的额度被思考吃光，正文一个字都没有，等了 10.3 分钟。
 *
 * 写正文真正需要的是：这一段要干什么（大纲的结构）+ 材料里的硬事实。
 * 选题阶段的论证过程对写正文没有增量——它已经被大纲吸收了。
 * 所以正文阶段只带大纲的结构化部分和硬事实，
 * 其余前序产出留给需要它们的阶段。
 */
function confirmedContext(projectId: string): string {
  const results = listStageResults(projectId);
  const parts: string[] = [];
  for (const stage of STAGE_ORDER) {
    const hit = results.find(item => item.stage === stage && item.status === "confirmed" && item.content.trim());
    if (!hit) continue;
    parts.push(`### ${STAGE_LABELS[stage]}\n\n${hit.content.trim()}`);
  }
  return parts.join("\n\n");
}

/**
 * 取大纲开头那两行：**全文主张**和**全文推进线**。
 *
 * 这两行是整篇文章的那条线。各段的「推进」是线上的点，这两行是线本身。
 * 正文提示词写着「大纲里已经写好了这条线」——线不在手上，
 * 模型就只能自己编一条，还要满足「每节都必须让线发生变化」这种没法执行的要求，
 * 于是转去长篇思考，正文一个字都交不出来（实测：正文阶段单请求跑满 600 秒被掐断）。
 *
 * 大纲是散文形态（老格式）时取不到这两行，返回空串，不影响别的路径。
 */
export function extractOutlineThread(outline: string): string {
  const lines: string[] = [];
  for (const line of outline.split(/\r?\n/)) {
    const hit = /^\s*\*\*\s*(全文主张|全文推进线)\s*\*\*\s*[：:]\s*(.+)$/.exec(line);
    if (hit) lines.push(`**${hit[1]}**：${hit[2].trim()}`);
  }
  return lines.join("\n");
}

/** 「说话位置」那四行的名字。顺序就是大纲里的顺序。 */
const VOICE_SLOTS = ["谁在说", "凭什么知道", "他的判断", "读者的追问"] as const;

/** 大纲里跟字数有关的行。正文阶段不要这些。 */
const LENGTH_LINE_RE = /总字数|字数估算|全文字数|篇幅合计|^\s*(?:>\s*)?篇幅\s*[：:]/;
/**
 * 取大纲开头的「说话位置」。
 *
 * 枪手 skill 里有一条方法：**动笔前先找到说话位置**——
 * 谁在说、他凭什么知道、他的判断是什么、读者会追问什么。
 * 这四件事想清楚了，稿子就有了人；没想清楚，模型只能写通稿。
 *
 * 原来这四件事是让模型在正文阶段自己想的。放在正文阶段想有两个坏处：
 * 一是要占额度（正文阶段的思考额度已经被内容挤满了），
 * 二是模型每写一段都要重新想一遍「我是谁」，各段的语气会飘。
 * 挪到大纲阶段一次想定，正文阶段直接照着这个人的口气写。
 *
 * 解析要宽容：模型可能写成 `**说话位置**：谁在说…` 后面跟四行带破折号的，
 * 也可能把四行并成一行，也可能给每行加粗。认不出来就返回空串，
 * 正文阶段退回「按普通作者写」，不猜。
 */
export function extractVoicePosition(outline: string): string {
  if (!outline) return "";
  const lines = outline.split(/\r?\n/);
  const found: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*\*+\s*说话位置\s*\*+\s*[：:]?\s*(.*)$/.exec(lines[i]);
    if (!head) continue;

    // 标题后面直接跟内容（「**说话位置**：谁在说…」）的情况。
    const inline = head[1].trim();
    if (inline) found.push(inline);

    // 从下一行开始收那四行。遇到下一个标题块就停。
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      // 下一个块（比如 `## 第 1 段` 或 `**全文主张**`）——收工。
      if (/^\s*#{1,6}\s/.test(line) || /^\s*\*\*.+\*\*/.test(line)) break;
      const item = /^\s*[-*+]?\s*(谁在说|凭什么知道|他的判断|读者的追问)\s*[：:]\s*(.+)$/.exec(line);
      if (item) {
        found.push(`${item[1]}：${item[2].trim()}`);
        continue;
      }
      // 不是四行里的任何一行，也不是标题：这一行大概是散文说明，收工。
      break;
    }
    break;
  }

  if (!found.length) return "";
  // 只留认得出来的那几行，模型漏写哪一行就缺哪一行，不替它补。
  return found
    .map(text => {
      const hit = /^(谁在说|凭什么知道|他的判断|读者的追问)\s*[：:]\s*(.+)$/.exec(text);
      return hit ? `${hit[1]}：${hit[2].trim()}` : text;
    })
    .filter(text => {
      const hit = /^(谁在说|凭什么知道|他的判断|读者的追问)\s*[：:]\s*(.+)$/.exec(text);
      return hit ? Boolean(hit[2].trim()) : text.trim().length > 0;
    })
    .join("\n");
}

/** 「说话位置」的四行里齐了没有。齐了才算数，缺行就退回「按普通作者写」。 */
export function isVoicePositionComplete(voice: string): boolean {
  if (!voice.trim()) return false;
  // 多行文本要开 m 标志，不然 `^` 只认第一行，后三行永远判不出来。
  return VOICE_SLOTS.every(slot => new RegExp(`^${slot}\\s*[：:]\\s*\\S`, "m").test(voice.trim()));
}

/**
 * 把大纲里的字数行去掉。
 *
 * 大纲解析不出结构时（模型把大纲写成散文），正文阶段会整份带上原大纲。
 * 那份大纲里有「总字数估算：2200–2500 字」和各段的「篇幅：225 字」——
 * 这些是给大纲阶段自己看的账，正文阶段看到它们就会去凑，
 * 于是又回到「限制输出」那条老路上。
 */
export function stripLengthLines(text: string): string {
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .filter(line => !LENGTH_LINE_RE.test(line))
    .join("\n")
    .trim();
}

/**
 * 正文阶段要的前序产出：**大纲 + 硬事实**，不要选题阶段的论证过程。
 *
 * 大纲取结构化部分：每段的推进、目的、内容、素材、篇幅、形式。
 *
 * **「推进」这一项是正文阶段的命根子。** 大纲提示词现在要求每段写一行
 * 「推进：这一段让全文推进线发生什么变化」——正文提示词里写着
 * 「大纲里已经写好了这条线」，那这行就必须真的带过去。
 * 少了它，模型只能自己临场拼一条线出来：既没有依据，又要满足
 * 「每节都必须让线发生变化」这种没法直接执行的要求，
 * 于是它转去长篇思考，正文一个字都交不出来（实测：正文阶段单请求跑满 600 秒被掐断）。
 *
 * 不取原大纲里的散文（「内容」字段在老大纲里经常是两百多字的成段描述，
 * 那是在大纲阶段就把正文写了一遍，带进来只会让正文重复表达）。
 * 但新大纲里「内容」是一句 35 字以内的话，不是散文——所以短就带、长就不带。
 *
 * 硬事实从材料解读里抽出来——写正文时能引用的数字、事件、原话都在这儿。
 * 这是「不编造」的最后一道保险：材料里没有的东西，正文不敢写。
 */
function articleContext(projectId: string): string {
  const outline = confirmedText(projectId, "outline");
  const brief = confirmedText(projectId, "brief");
  const parts: string[] = [];

  if (outline.trim()) {
    const paragraphs = parseOutlineParagraphs(outline);
    const thread = extractOutlineThread(outline);
    if (thread) {
      parts.push(`### 这篇稿子的主线\n\n${thread}`);
    }
    // 说话位置。定了是谁在说，正文才有一个人可以借着说话。
    // 四行不齐就不给（宁可没有，也不要给个半截的），
    // 正文提示词里写的是「大纲开头如果有一块说话位置」，
    // 缺了这块它会退回「按一个真正懂这行的人写」。
    const voice = extractVoicePosition(outline);
    if (isVoicePositionComplete(voice)) {
      parts.push(`### 谁在说话\n\n${voice}`);
    }
    if (paragraphs.length) {
      const lines = paragraphs.map(item => {
        const label = item.label.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
        const bits = [`**${label}**`];
        if (item.advance.trim()) bits.push(`推进：${item.advance.trim()}`);
        if (item.purpose.trim()) bits.push(`目的：${item.purpose.trim()}`);
        // 内容字段超过 40 字，说明那一段是散文而不是一句话交代。
        // 那种内容带进来就是让正文复述一遍，不要。
        if (item.content.trim() && item.content.trim().length <= 40) {
          bits.push(`内容：${item.content.trim()}`);
        }
        if (item.material.trim()) bits.push(`素材：${item.material.trim()}`);
        if (item.format.trim()) bits.push(`形式：${item.format.trim()}`);
        return bits.join("｜");
      });
      parts.push(`### 写作大纲的结构\n\n${lines.join("\n")}`);
    } else {
      // 大纲是散文形态，解析不出结构：整份带上，但把字数账去掉。
      parts.push(`### 写作大纲\n\n${stripLengthLines(outline.trim())}`);
    }
  }

  const facts = extractHardFacts(brief);
  if (facts.trim()) {
    parts.push(`### 材料里的硬事实\n\n${facts.trim()}`);
  }

  return parts.join("\n\n");
}

/** 取某个阶段已签字的产出正文。 */
function confirmedText(projectId: string, stage: Stage): string {
  const results = listStageResults(projectId);
  const hit = results.find(item => item.stage === stage && item.status === "confirmed" && item.content.trim());
  return hit ? hit.content.trim() : "";
}

/**
 * 这一阶段的全文字数目标。
 *
 * 大纲阶段和正文阶段要的不是同一个东西：
 * 大纲阶段要的是「各段加起来等于多少」，正文阶段要的是「成稿落在这个数上」。
 * 但目标的**来源**是同一套：用户这次说的最算数，其次是大纲的总账，
 * 再次是选题给的适合篇幅，最后是材料里写的——
 * 都找不到，就用默认篇幅（公众号是短文，700–1200 字）。
 *
 * 选题阶段也要拿目标：它要给的「适合篇幅」建议得落在这个量级上，
 * 否则大纲阶段会照着一个三千字的总账去排段落。
 *
 * 默认篇幅同时是**上限**：模型自己写的数（大纲的总账、选题的适合篇幅、
 * 材料里定的篇幅）只能在 700–1200 之间收窄，推不出去；
 * 用户自己说的数不受这个限制。见 `clampToEnvelope`。
 */
function stageLengthTarget(input: StageRunInput): LengthTarget | null {
  const common = {
    userInput: input.userInput,
    manual: input.lengthTarget,
    defaultTarget: DEFAULT_ARTICLE_LENGTH,
    envelope: DEFAULT_ARTICLE_LENGTH,
  };

  if (input.stage === "outline") {
    // 大纲阶段不拿旧大纲的总账当目标：那一版正是要重写的东西。
    return resolveLengthTarget({
      ...common,
      angle: confirmedText(input.projectId, "angle"),
      brief: confirmedText(input.projectId, "brief"),
    });
  }
  if (input.stage === "article") {
    return resolveLengthTarget({
      ...common,
      outline: confirmedText(input.projectId, "outline"),
      angle: confirmedText(input.projectId, "angle"),
      brief: confirmedText(input.projectId, "brief"),
    });
  }
  if (input.stage === "angle") {
    return resolveLengthTarget({
      ...common,
      brief: confirmedText(input.projectId, "brief"),
    });
  }
  return null;
}

/**
 * 一次生成要多少额度。
 *
 * `max_tokens` 是「思考 + 正文」的总额度，中文一个字大约一个多 token，
 * 还要给思考留出几千个——所以额度得跟着目标字数走，不能一刀切。
 *
 * 量出来的几档：
 * - 2000 字：8192 一次写完（实测 2068 汉字，31.6 秒，思考没挤掉正文）。
 * - 3500 字：8192 不够，连着两次被截断，每次都要重来一遍（实测生成阶段十分钟）。
 * - 4000 字以上：再上一档。
 *
 * 宁可一次给够，也不要靠「被截断了就加倍」——加倍意味着前面的请求白等，
 * 而且思考照样能把额度吃光（探针实测 8192 加倍到 16384，16384 个 token 全进了思考）。
 */
export function generationBudget(target: LengthTarget | null): number {
  const han = target?.min ?? 0;
  if (han <= 2000) return 8192;
  if (han <= 4000) return 16384;
  return 32768;
}

/**
 * 超过多少字就走分节生成。
 *
 * 一次性写长文有两个毛病（真模型实测，2026-10-23）：
 * 一是**不稳**——同一条 3500 字的请求连着跑 4 次，3 次一个字都没交出来；
 * 二是**长度对不上**——交出来的那次只写了 2066 字，正好是上下文里上一稿的 2068 字，
 * 也就是说模型是照着旧稿的长度写的，让它写 3500 它就写 2000。
 *
 * 2000 字以内一次性写完是又快又好的（实测 31.6 秒、2068 字、零硬禁令），
 * 所以这个门槛放在 2400 字：短文照旧一次写完，长文按节写。
 */
const SECTION_GENERATION_THRESHOLD = 2400;

/**
 * 从技能包正文里取出「怎么写」那一节。
 *
 * 分节生成不经过技能工具（模型没法在八个请求里各读一次技能包），
 * 所以方法要由服务端直接带进每一节的提示词。
 *
 * **为什么取方法节、不取禁令节。**
 *
 * 原来取的是「成稿绝对不能出现」那一节——十条硬禁令。
 * 真模型实测（2026-10-23）：这类清单是额度被吃光的元凶。
 * 模型拿到十条禁令会先在心里逐条核对（有没有冒号？有没有翻案腔？黑话用了几个？），
 * 思考直接吃满 max_tokens，正文一个字都交不出来。
 * 探针实测：16384 额度 → reasoningTokens=16384，正文 0 字，finish_reason=length。
 *
 * 改成方法节之后，给模型的是「怎么写」而不是「不许写什么」：
 * 方法给出路，禁令只给墙。模型照着方法往前走就行，
 * 那些文风问题交给服务端体检量出来给人看，不在生成阶段死磕。
 *
 * 只取这一节，不取整份技能包：整份里有几节是要求模型先做内部自查的，
 * 那种「先列清单再动笔」的指令同样会让它陷进逐条核对的思考。
 */
export function extractWritingMethodSection(skillText: string): string {
  const head = /^[#]{2,3}\s*(第一稿直接带着人写|怎么写|写作方法)\s*$/m.exec(skillText);
  if (!head) return "";
  const rest = skillText.slice(head.index + head[0].length);
  const next = /^[#]{2,3}\s/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/**
 * 从启用的技能包里取出「怎么写」那一节。
 *
 * 读不到就返回空串：技能包坏了不该拖垮整篇文章，
 * 产品自己的正文提示词里本来就带着完整的写作方法。
 */
async function readWritingMethodGuidance(
  catalog: SkillCatalog | null,
  wanted: string[],
): Promise<string> {
  if (!catalog || !wanted.length) return "";
  const parts: string[] = [];
  for (const id of wanted) {
    try {
      const file = await catalog.read(`${id}/SKILL.md`);
      const section = extractWritingMethodSection(file.content);
      if (section) parts.push(section);
    } catch {
      // 读不到就算了，不影响分节生成。
    }
  }
  return parts.join("\n\n");
}

/**
 * 材料解读里的「硬事实」。
 *
 * 大纲里写的是「素材：材料第 3 段的对比数据」，
 * 分节生成要能把这句翻译成具体的事实，模型手里就得有那份清单。
 */
export function extractHardFacts(brief: string): string {
  const trimmed = brief.trim();
  if (!trimmed) return "";
  const head = /^[#]{2,3}\s*硬事实\s*$/m.exec(trimmed);
  if (!head) return trimmed;
  const rest = trimmed.slice(head.index + head[0].length);
  const next = /^[#]{2,3}\s/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/**
 * 组装发给模型的消息。
 *
 * 约定：系统消息只有一条，其余是 user/assistant 交替的历史与本次输入。
 * 历史消息直接取自消息表，因此「追问」天然是连续的，不需要额外维护会话状态。
 */
export async function buildStageMessages(
  input: StageRunInput,
  options: { skillCatalog?: SkillCatalog; methodGuidance?: string } = {},
): Promise<ChatMessage[]> {
  const [globalPrompt, styleProfile] = await Promise.all([
    readAgentConfig()
      .then(config => config.systemPrompt?.trim() ?? "")
      .catch(() => ""),
    Promise.resolve(input.styleProfile?.trim() ?? ""),
  ]);

  // 模板里的占位符在这里一次性填好，避免把 {{...}} 原样发进模型。
  const lengthTarget = stageLengthTarget(input);
  const confirmedOutline = confirmedText(input.projectId, "outline");
  const stageTemplate = getPrompt(input.stage);

  // 中间工序自己的字数上限。
  //
  // 这一条跟「本次的字数目标」是两回事，别混：
  // - 字数目标说的是**正文成稿**该多长（700–1200 字）；
  // - 这里说的是**这一道工序的产物**该多长（大纲 600 字、选题 500 字、材料解读 800 字）。
  //
  // 模型分不清这两件事：提示词里说了「这是施工图」，它照样会把大纲写成 1788 字的草稿
  // （真模型实测，2026-10-23）。必须给一个具体的数字上限。
  //
  // 模板里写了占位符就用占位符，没写就补一段——规则不能因为用户改了模板就丢掉。
  const outputBudgetInstruction =
    input.stage === "outline" || input.stage === "angle" || input.stage === "brief"
      ? stageOutputBudget(input.stage)?.instruction ?? ""
      : "";

  const vars: Record<string, string> = {
    topic: input.topicName?.trim() ?? "",
    topic_rules: input.topicRules?.trim() ?? "",
    style: styleProfile,
    brief: confirmedText(input.projectId, "brief"),
    angle: confirmedText(input.projectId, "angle"),
    outline: confirmedOutline,
    article: confirmedText(input.projectId, "article"),
    // 字数指令只给选题和大纲两道工序。
    //
    // **正文阶段没有字数指令**——作者 2026-10-23 的原话：
    // 「到最后你限制他输出有个屁用啊」「你还在那追究个屁的字数啊」。
    // 正文要的是把大纲的线和技能包的写法用上；提示词里塞一个数字，
    // 只会换来「为了凑数而重复解释」和「稿台自己跟自己较劲」。
    // 字数目标还在（用于算输出额度、以及成稿后那份只读体检报告），
    // 但它不進正文提示词。
    length_target:
      input.stage === "angle"
        ? renderLengthInstruction(lengthTarget, "angle")
        : input.stage === "outline"
          ? renderLengthInstruction(lengthTarget, "outline")
          : "",
    // 这一道工序自己该有多长（大纲 700 字、选题 700 字、材料解读 800 字）。
    output_budget: outputBudgetInstruction,
  };

  // 字数目标不能只活模板的占位符里。
  // 模板是用户能改的文件，占位符一被删掉，规则就静默消失——
  // 真模型实测（2026-10-23）：angle.md 里少了 {{length_target}}，
  // 选题阶段压根没收到字数指令，三个角度的「适合篇幅」直接飘到 2000–2500 字。
  // 所以模板里没写占位符时，这里补一段，规则不会因为改模板而丢掉。
  //
  // 正文阶段不参与：它压根就没有字数指令。
  const lengthInstruction =
    input.stage === "angle" || input.stage === "outline"
      ? renderLengthInstruction(lengthTarget, input.stage)
      : "";
  const lengthFallback =
    lengthInstruction && !stageTemplate.includes("{{length_target}}")
      ? section("本次的字数目标", lengthInstruction)
      : "";

  const sectionOutputFallback =
    outputBudgetInstruction && !stageTemplate.includes("{{output_budget}}")
      ? section("这一道工序的产物该有多长", outputBudgetInstruction)
      : "";

  const systemParts = [
    section("全局要求", renderPrompt(getPrompt("system"), vars)),
    section("本阶段要求", renderPrompt(stageTemplate, vars)),
    lengthFallback,
    // 中间工序自己该有多长，跟正文目标不是一回事。
    // 大纲 600 字、选题 500 字、材料解读 800 字：
    // 不给这个上限，模型会把施工图写成草稿（实测大纲 1788 字，比正文 900 字还长）。
    sectionOutputFallback,
    section("风格画像使用说明", styleProfile ? renderPrompt(getPrompt("style-profile"), vars) : ""),
    section("专题规则", input.topicRules?.trim() ?? ""),
    section("作者风格", styleProfile),
    // 正文阶段只拿大纲的结构和硬事实；其它阶段才拿前序产出的全文。
    section(
      "前序阶段产出",
      input.stage === "article" ? articleContext(input.projectId) : confirmedContext(input.projectId),
    ),
    section("附加提示", globalPrompt),
    section("可用技能包", options.skillCatalog ? renderSkillCatalog(options.skillCatalog) : ""),
    // 技能包里的写作方法，由服务端直接读出来塞进提示词。
    //
    // 为什么不让模型自己读：这个阶段要写 700–1200 字的成稿，
    // 模型先调工具读 15KB 的 SKILL.md、可能再读 24KB 的参考文件，
    // 每轮都要把这些重发一遍。真模型实测（2026-10-23）：这么走一轮要 10.3 分钟，
    // 额度全被长上下文的思考吃光，正文一个字都没有。
    //
    // 只取「怎么写」那一节：给方法，不给禁令。
    // 禁令清单会让模型先逐条核对（有没有冒号？有没有翻案腔？），
    // 思考吃满额度、正文一个字没有——探针实测 16384 额度全进了思考。
    // 其余章节（怎么找说话位置、怎么改稿）对 700–1200 字的短文不是必需，
    // 让模型自己去读反而更慢。
    section("技能包里的写作方法", options.methodGuidance ?? ""),
  ].filter(Boolean);

  const messages: ChatMessage[] = [
    { role: "system", content: systemParts.join("\n\n") },
  ];

  for (const item of listMessages(input.projectId, input.stage)) {
    if (!item.content.trim()) continue;
    messages.push({ role: item.role, content: item.content });
  }

  messages.push({ role: "user", content: input.userInput.trim() || defaultStageInstruction(input.stage) });
  return messages;
}

/**
 * 用户没填内容时，替他说一句「往下走」。
 *
 * 界面允许直接点生成（不填意见），但**模型不能收到一条空消息**——
 * 空消息会让它不知道要干什么，要么反问，要么随便编一段。
 * 所以这里按阶段给一句明确的指令：**基于上面的材料，直接往下走。**
 */
function defaultStageInstruction(stage: Stage): string {
  switch (stage) {
    case "angle":
      return "请基于上面的材料解读，给出几个能写成稿子的方向。";
    case "outline":
      return "请基于上面选定的方向，直接给出一份大纲。";
    case "article":
      return "请按上面的大纲写出正文。";
    default:
      return "请基于上面的内容继续。";
  }
}

/**
 * 跑一次阶段。
 *
 * 顺序很重要：先跑模型，成功之后再落库。模型失败时库里不留半截记录，
 * 否则界面上会出现「一段说了一半的正文」，用户分辨不出是模型输出还是被截断了。
 */
export async function runStage(input: StageRunInput): Promise<StageRunResult> {
  const project = getProject(input.projectId);
  if (!project) throw new Error("稿件不存在或已被删除。");

  // 技能包在两个阶段可用：
  // - 材料解读阶段：用户的输入常常是两三千字的原话，
  //   「怎么总结、总结成什么样」正是要一个技能包来管的事
  //   （作者会自己写一个总结用的 skill）。
  // - 正文阶段：写作方法。
  // 中间两个阶段要的是判断和结构，硬塞一份写作方法只会稀释注意力。
  const skillStages: Stage[] = ["brief", "article"];
  const wanted = skillStages.includes(input.stage) ? (input.skills ?? []) : [];
  const catalog = wanted.length ? await openSkills(wanted) : null;
  // 正文阶段的写作方法，服务端先读出来直接放进提示词。
  // 不让模型自己跑工具去读：读一次 SKILL.md 是 15KB，可能再读 24KB 的参考文件，
  // 每轮都要重发一遍——真模型实测（2026-10-23）：正文阶段这么走了一轮是 10.3 分钟，
  // 额度全被长上下文的思考吃光，正文一个字都没有。
  const methodGuidance =
    input.stage === "article" ? await readWritingMethodGuidance(catalog, wanted) : "";
  // 正文阶段**只拿写作方法，不拿技能包清单**。
  //
  // 清单里写着「用 read_skill_file 读入口文件」和「改用 check_prose 工具做同一件事」，
  // 可正文阶段一个工具都不给（见下面那个分支）。让模型去调它调不到的工具，
  // 是一条程序型指令——它会先去琢磨怎么调，白白吃掉思考额度。
  // 写作方法由服务端读出来直接塞进提示词（methodGuidance），这一节才是正文要的。
  const messages = await buildStageMessages(
    input,
    input.stage === "article"
      ? { methodGuidance }
      : catalog
        ? { skillCatalog: catalog, methodGuidance }
        : { methodGuidance },
  );
  // 额度按字数目标给。8192 是量出来的底：angle 阶段连续三次 0 正文，
  // 额度放到 8192 时思考只花掉 307 个 token，36 秒就写完了。
  // 但它只够写两千字左右——目标更长时额度要跟着长，
  // 否则模型写到一半被截断，稿台把额度加倍重来，一来一回又是好几分钟。
  // 真模型实测（2026-10-23）：3500 字的目标用 8192，连着被截两次，
  // 生成阶段单这一项就花掉十分钟。
  const maxTokens = generationBudget(stageLengthTarget(input));
  // 真模型上一次生成可能跑好几分钟（带思考的模型尤其慢，额度重试还会翻倍）。
  // 默认的 240 秒会把正在写的稿子掐掉，按阶段给宽一点。
  //
  // 正文阶段给 300 秒，不给 600 秒：
  // 端点上「思考螺旋」的表现不是交出空稿，而是**一直想、一直不交**。
  // 真模型实测（2026-10-23）：正文阶段单次请求跑满 600 秒被掐断，一个字没有。
  // 等满 600 秒才发现不对，用户白等十分钟；而螺旋一旦发生，
  // 换个提示词或加点额度都救不回来，只能换一条路（分节生成）。
  // 所以宁可早一点发现，早一点换路。
  const timeoutMs = input.stage === "article" ? 300_000 : 360_000;

  let content: string;
  let skillWarning: string | undefined;
  let finishReason: string | undefined;

  // 各步骤花了多久。界面上要能说清楚「慢在生成还是慢在补写」。
  const timings: StageTiming[] = [];
  // 把上一个阶段残留的计时清掉，别算到这一阶段头上。
  drainLlmTimings();

  // 正文阶段的三样账：字数目标、大纲的段落、每段的字数。
  // 一次性生成用它算额度，分节生成用它排每一节的字数。
  const target = input.stage === "article" ? stageLengthTarget(input) : null;
  const confirmedOutline = confirmedText(input.projectId, "outline");
  // 有没有已确认的大纲。这一条决定正文阶段「空了就重试」还是「空了换条路」。
  const hasConfirmedOutline = confirmedOutline.trim().length > 0;
  const paragraphs = fitParagraphsToTarget(
    parseOutlineParagraphs(confirmedOutline),
    target,
  );
  const sectionPlans = planSectionWriting({
    paragraphs,
    totalTarget: target?.min ?? 0,
  });
  // 长文走分节生成。短文照旧一次写完（实测 31.6 秒，2068 字，零硬禁令）。
  const useSectionWriting =
    input.stage === "article" &&
    sectionPlans.length >= 2 &&
    (target?.min ?? 0) > SECTION_GENERATION_THRESHOLD;

  /** 分节生成的产出与逐节说明。 */
  let sectionNotes: string[] = [];

  /** 按节把整篇文章写出来。 */
  const writeSections = async (): Promise<string> => {
    const guidance = await readWritingMethodGuidance(catalog, wanted);
    const facts = extractHardFacts(confirmedText(input.projectId, "brief"));
    // 分节生成时每一节都是独立请求，谁在说必须一起给，
    // 否则每节自己挑一个语气，拼起来像几个人写的。
    const voice = extractVoicePosition(confirmedOutline);
    const result = await writeArticleBySections({
      plans: sectionPlans,
      outline: paragraphs,
      facts,
      guidance,
      voice: isVoicePositionComplete(voice) ? voice : undefined,
      timeoutMs,
    });
    sectionNotes = result.notes;
    return result.content;
  };

  // 生成正文。
  //
  // 这里包一层 try：正文阶段一旦超时（模型陷进思考螺旋，一直想、一直不交），
  // 错误会直接冒到接口层，用户看到的是一次 500 和十分钟的等待。
  // 接住它换条路：分节生成每节的输出小、交得出正文。
  try {
    if (useSectionWriting) {
      // 分节生成不经过技能工具：每一节单独发一次请求，没法每节都读一次技能包。
      // 所以这里把技能包里的写作方法直接带进每一节的提示词，
      // 并如实告诉用户这次没有按技能包走流程。
      content = await writeSections();
      timings.push(collectTimings("分节生成"));
      skillWarning = "这篇是按节生成的，模型没有逐节读取技能包，正文按的是产品自己的写作规则。";
    } else if (catalog && input.stage !== "article") {
      // 材料解读与选题阶段：让模型自己去读技能包。
      const result = await chatWithTools({
        messages,
        tools: [catalog.tool],
        maxTokens,
        timeoutMs,
        label: "生成",
        // 工具循环最多跑几轮。每轮都要把整段对话重发一遍，
        // 而工具结果还在不断加长它；3 轮够走完一条完整链路，
        // 再多就是模型绕圈，runToolLoop 自己也会拦重复调用。
        maxRounds: 3,
        handler: async (name, args) => {
          if (name !== catalog.tool.function.name) return `没有这个工具：${name}`;
          const file = typeof args.file === "string" ? args.file.trim() : "";
          if (!file) throw new Error("缺少 file 参数。");
          const read = await catalog.read(file);
          return read.content;
        },
      });
      content = result.content;
      finishReason = result.finishReason;

      // 告警要说得像这一阶段的事：材料解读阶段说「正文」是驴唇不对马嘴。
      const subject = input.stage === "brief" ? "这次材料解读" : "这次选题角度";
      if (result.degraded) {
        skillWarning = `模型服务不支持工具调用，${subject}没有按技能包的要求写。`;
      } else if (!result.toolsUsed) {
        skillWarning = `模型这次没有主动读取技能包，${subject}不是按技能要求写的。`;
      } else {
        const missing = catalog.skills.filter(skill => !catalog.loaded.has(skill.id));
        if (missing.length) {
          skillWarning = `模型没有读 ${missing.map(skill => `${skill.id}/SKILL.md`).join("、")}，${subject}不是按技能要求写的。`;
        }
      }

      if (result.toolLoopExhausted) {
        skillWarning = `${skillWarning ? `${skillWarning} ` : ""}模型反复调用工具没有收尾，下面是它写的最后一版，签字前请先通读。`;
      }
    } else {
      // 正文阶段：**不给模型任何工具**。
      //
      // 以前这里给过体检工具（check_prose），让模型写完初稿自查一遍再改。
      // 现在不给了，两个原因：
      //
      // 1. 稿台自己就在成稿后跑一遍体检（reportArticle），结果照旧展示给用户。
      //    模型再自查一遍，是同一件事做两遍。
      // 2. 「写完自查再改」是一条**程序型指令**：它要求模型在思考里执行一套
      //    「检查—修补」的流程。真模型实测（2026-10-23）：正文请求带这种指令时，
      //    思考额度被吃光、正文一个字都没有。
      //
      // 技能包的写作方法由服务端注入（见上面 methodGuidance），不依赖模型调工具。
      const result = await chat({
        messages,
        maxTokens,
        timeoutMs,
        label: "生成",
        // 正文阶段只要有已确认的大纲就不重试：同一条请求连着三次都是空的
        // （真模型实测 2026-10-23），等三次等于白等六分钟，
        // 而且每次都要把越滚越大的上下文重发一遍。
        // 空了就换条路：有大纲段落就走分节生成（那条路交得出正文），
        // 没有就干脆快速失败——让用户早点看到原因，比干等六分钟强。
        // **没有大纲时必须留着重试**：那时没有别的路可走，
        // 空正文没有第二次机会，这一阶段就彻底废了（实测：没有已确认大纲时就会这样）。
        ...(input.stage === "article" && hasConfirmedOutline ? { retries: 0 } : {}),
      });
      content = result.content;
      finishReason = result.finishReason;

      // 正文阶段不走「模型自己读技能包」这条路：写作方法由服务端注入。
      // 所以这里判断的是「有没有拿到那节方法」，而不是「模型有没有调工具」。
      if (input.stage === "article" && !methodGuidance && wanted.length) {
        skillWarning = "这次没有取到技能包里的写作方法，正文按的是产品自己的写作规则。";
      }
    }
  } catch (error) {
    // 只有正文阶段有分节这条退路；其它阶段照原样把错误抛出去。
    const timedOut = error instanceof Error && /超时/.test(error.message);
    if (input.stage !== "article" || useSectionWriting || sectionPlans.length < 2 || !timedOut) {
      throw error;
    }
    content = await writeSections();
    timings.push(collectTimings("分节生成"));
    if (content.trim()) {
      skillWarning = `${skillWarning ? `${skillWarning} ` : ""}一次性生成超时（模型把时间花在了思考上），这一版改成分节生成写出来的。`;
    }
  }

  timings.push(collectTimings("生成"));

  // 一次性生成一个字都没交出来时，别在这儿死等重试。
  // 真模型实测（2026-10-23）：3500 字那条请求连着三次都是空的，
  // 每次两分钟——等三次等于白等六分钟，什么也没得到。
  // 换一条更稳的路：按节生成，每节的输出小，交得出正文。
  if (!content.trim() && !useSectionWriting && sectionPlans.length >= 2) {
    content = await writeSections();
    timings.push(collectTimings("分节生成"));
    if (content.trim()) {
      skillWarning = `${skillWarning ? `${skillWarning} ` : ""}一次性生成没交出正文，这一版改成分节生成写出来的。`;
    }
  }

  // 一个字都没写出来：空白不能当结果交出去。
  // 真模型实测：带思考的端点可能把 max_tokens 全花在思考上，正文一个字没有。
  // 已经自动换过策略重试两次（先降思考强度，再抬温度换采样），还是空，就明说，
  // 不能交一份 0 字的草稿让用户以为写完了。
  if (!content.trim()) {
    const cause =
      finishReason === "length"
        ? "输出额度被模型的思考占满了，正文一个字都没写出来。"
        : "模型这次没有返回任何内容。";
    throw new Error(
      `${cause}已经换过思考强度和采样重试过两次都没拿到正文。可以在「模型」页把「思考强度」调成 minimal 或 none（写长文时额度要全留给正文），或者换一个模型再试。`,
    );
  }

  // 成稿体检。只在正文阶段做：
  // 前面三道工序要的是判断和结构，套一把散文尺子没有意义，还白花一次模型调用。
  //
  // 体检是**只读报告**，不是闸门。
  //
  // 原来的做法是：量一遍，不合格就让模型改一轮（去重 → 按句改写 → 按节补写 → 两版挑一版）。
  // 砍掉这条链有三个理由：
  // 1. 真模型实测（2026-10-23）：整篇重写和补写在这个端点上极不可靠，
  //    额度全被思考吃光、正文一个字交不出来，等一圈下来什么也没改成。
  // 2. 改写会顺手把稿子改短、改钝——「冒号少了但字数更短了」的情况真实发生过，
  //    改坏比不改更麻烦。
  // 3. 用户要的是一份能自己判断的稿子，不是一份被机器来回搓过的稿子。
  //    尺子量出来的问题摆在那里，怎么改是人来决定。
  let quality: ArticleQuality | undefined;

  if (input.stage === "article") {
    const report = reportArticle(content, target);
    const notes: string[] = [...sectionNotes];

    // 大纲要点覆盖：这一篇该写的都写到了吗。
    //
    // 这是「合格线」的真正口径——不是字数，是大纲上要的每一点有没有落地。
    // 差多少字不拦路（材料撑不起就写短），但大纲里规划过的内容漏了要说出来。
    const coverage = checkOutlineCoverage(paragraphs, content);
    if (coverage.total > 0) {
      notes.push(
        `大纲要点覆盖：${coverage.covered} / ${coverage.total} 段在正文里落地。` +
          (coverage.missing.length
            ? `未落地：${coverage.missing.join("、")}。`
            : "全部落地。"),
      );
    }

    quality = {
      hanCount: report.hanCount,
      failCount: report.failCount,
      warnCount: report.warnCount,
      missing: report.missing,
      target: target
        ? {
            min: target.min,
            max: target.max,
            source: target.source,
            sourceLabel: LENGTH_SOURCE_LABELS[target.source],
            raw: target.raw,
          }
        : null,
      findings: report.prose.findings,
      coverage: coverage.total > 0
        ? { covered: coverage.covered, total: coverage.total, missing: coverage.missing }
        : undefined,
      ...(notes.length ? { notes } : {}),
    };
  }

  appendMessage({ projectId: input.projectId, stage: input.stage, role: "user", content: input.userInput });
  appendMessage({ projectId: input.projectId, stage: input.stage, role: "assistant", content });

  const stageResult = saveStageResult({
    projectId: input.projectId,
    stage: input.stage,
    content,
    status: "draft",
  });

  return {
    content,
    stageResult,
    messages,
    ...(skillWarning ? { skillWarning } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(quality ? { quality } : {}),
    ...(timings.length ? { timings } : {}),
  };
}

/**
 * 为文章生成一张配图的视觉提示词。
 *
 * image-prompt.md 是**指令集**（怎么写提示词），不是填空模板：
 * 真正要写提示词的是模型。所以这里拼一条系统消息 + 一条用户消息去问模型，
 * 拿回来的才是提示词本身。
 *
 * 提示词是给图像模型看的，因此只描述画面：构图、主体、配色、留白，
 * 不出现「公众号」「配图位」这类对它没有意义的词。
 */
export async function buildImagePrompt(args: { title: string; article: string; index: number }): Promise<string> {
  const article = args.article.slice(0, 2000);
  const globalPrompt = await readAgentConfig()
    .then(config => config.systemPrompt?.trim() ?? "")
    .catch(() => "");

  const instruction = getPrompt("image-prompt").trim();
  const system = [
    section("全局要求", renderPrompt(getPrompt("system"), {})),
    section("本阶段要求", instruction || "为文章写一段图像模型的提示词，只描述画面。"),
    section("附加提示", globalPrompt),
  ]
    .filter(Boolean)
    .join("\n\n");

  const user = `标题：${args.title}\n\n这是全文的第 ${args.index + 1} 段配图，文章节选如下：\n\n${article}`;

  try {
    const result = await chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 512,
    });
    const text = result.content.trim();
    if (text) return text;
  } catch (error) {
    // 模型不可用时不给空结果：退回到一个至少能用的画面描述，
    // 并把原因带上，让用户知道是降级而不是模型真的这么写。
    const reason = error instanceof Error ? error.message : String(error);
    return `为一篇题为「${args.title}」的文章绘制一张横版配图（16:9）。画面主体取自文章要点，构图简洁，留出标题文字位置，色彩克制。（生成失败：${reason}）`;
  }

  return `为一篇题为「${args.title}」的文章绘制一张横版配图（16:9）。画面主体取自文章要点，构图简洁，留出标题文字位置，色彩克制。`;
}
