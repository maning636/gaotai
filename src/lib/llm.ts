import { readAgentConfig } from "./agent-config-store";
import { ensureLongLivedFetchTimeout } from "./fetch-timeout";
import { findDegenerateRepetition } from "./repetition";

// Node 的 fetch 默认 300 秒就放弃等响应头，长文请求会被它先掐断。
// 模块加载时换一次全局 dispatcher 即可，之后实际管事的是我们自己的超时。
ensureLongLivedFetchTimeout();

/**
 * 模型接入层。
 *
 * 直接对接 OpenAI 兼容的 /chat/completions，不引入任何 Agent 框架：
 * - 少一层抽象，就少一层出错的地方，也少一份安装包体积；
 * - 拿得到真实的 HTTP 状态码与响应体，错误提示才写得出来。
 *
 * 系统提示不在这里组装——那是阶段引擎的职责。这里只负责「把消息发出去、把结果拿回来」。
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 模型发起的一次工具调用。 */
export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** 工具定义（OpenAI function calling 的形状，DeepSeek 等兼容端点通用）。 */
export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  /** assistant 消息里模型要的工具调用。 */
  tool_calls?: ChatToolCall[];
  /** role 为 tool 时，指明这条结果回应的是哪次调用。 */
  tool_call_id?: string;
};

export type ChatOptions = {
  messages: ChatMessage[];
  /** 缺省用模型配置里的 temperature。 */
  temperature?: number;
  /** 缺省 8192。写长文时不够用时由调用方显式提高。 */
  maxTokens?: number;
  /** 外部取消信号。 */
  signal?: AbortSignal;
  /** 单次请求超时，缺省 240 秒。 */
  timeoutMs?: number;
  /** 本次可用的工具。给了之后模型可以主动调用。 */
  tools?: ChatTool[];
  /** 强制模型调用某个工具。 */
  toolChoice?: "auto" | "none" | "required";
  /**
   * 本次请求的思考强度。没给就用模型配置里的。
   *
   * 小任务（改一句话、补一节）要显式写 "none"：
   * 直连真模型实测（2026-10-22），同一个补写请求
   * 在 minimal 下思考把 8192 个额度吃光、正文一个字没有，
   * 在 none 下思考只花 3005 个、正文照常交出来。
   * 不写这一句，每次小任务都要先空转一次再降级重来，白等一分钟。
   */
  reasoningEffort?: string;
  /** 本次请求的标签，只用于计时与排查。 */
  label?: string;
  /**
   * 这一次最多重试几遍。缺省 2。
   *
   * 给 0 的场合只有一个：正文阶段的整篇生成。
   * 真模型实测（2026-10-23）：3500 字那条请求连着三次都是空的，
   * 每次两分钟——等三次等于白等六分钟。
   * 与其等，不如换一条路（按节生成），所以那里干脆不重试。
   */
  retries?: number;
};

export type ChatUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 花在思考上的 token。有些端点把它算进 completionTokens。 */
  reasoningTokens?: number;
};

export type ChatResult = {
  content: string;
  model: string;
  finishReason?: string;
  usage?: ChatUsage;
  /** 模型这轮要调用的工具。 */
  toolCalls?: ChatToolCall[];
  /** 模型的思考内容。端点把它单独放在 reasoning 字段里。 */
  reasoning?: string;
};

export class LlmError extends Error {
  /** HTTP 状态码；网络层错误没有状态码。 */
  status?: number;
  /** 服务端返回的原文片段（已截断），用于排障。 */
  detail?: string;

  constructor(message: string, options?: { status?: number; detail?: string }) {
    super(message);
    this.name = "LlmError";
    this.status = options?.status;
    this.detail = options?.detail;
  }
}

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_TOKENS = 8192;

/** 配置文件里有可用的 key 才算配置好。 */
export async function isLlmConfigured(): Promise<boolean> {
  try {
    const config = await readAgentConfig();
    return Boolean(config.apiKey?.trim());
  } catch {
    return false;
  }
}

/**
 * 端点认不认 reasoning_effort。
 *
 * 不认的端点会回 400。第一次撞上之后就把这个事实记下来，
 * 之后不再发这个字段——不然每次请求都要白跑一趟。
 */
let reasoningEffortUnsupported = false;

/**
 * 把两个取消源合成一个。
 *
 * 外部 signal 与内部超时都要能中断请求，而 AbortSignal.any 在较老的 Node 上不存在，
 * 因此手工串联：任一触发就 abort 合并后的信号。
 */
function linkSignals(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new LlmError(`模型请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或调大超时。`));
  }, timeoutMs);

  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function normalizeUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  const result: ChatUsage = {};
  if (typeof usage.prompt_tokens === "number") result.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") result.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") result.totalTokens = usage.total_tokens;
  // 有些端点把思考的 token 算进 completion_tokens，这个数字能说明
  // 「额度是不是全花在思考上了」——正文一个字没出来的时候，第一眼就要看它。
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number") result.reasoningTokens = reasoning;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 归一化模型返回的工具调用。
 *
 * 不同厂商的返回形状有细微差别（有的 arguments 是字符串，有的已经是对象；
 * 有的缺 id），这里只保留能确定的部分，坏掉的条目直接丢掉——
 * 一条形状不对的工具调用会让整轮对话对不上。
 */
function normalizeToolCalls(raw: unknown): ChatToolCall[] {
  if (!Array.isArray(raw)) return [];
  const result: ChatToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = entry.function?.name;
    if (typeof name !== "string" || !name) continue;
    const args = entry.function?.arguments;
    const argumentsText =
      typeof args === "string" ? args : JSON.stringify(args ?? {});
    const id = typeof entry.id === "string" && entry.id ? entry.id : `call_${result.length + 1}`;
    result.push({ id, type: "function", function: { name, arguments: argumentsText } });
  }
  return result;
}

/**
 * 模型把工具调用写成了正文。
 *
 * 有些端点不返回结构化的 `tool_calls`，而是把调用写进正文里（实测 SenseNova 6.8）：
 *
 * ```
 * <tool_calls>
 * <invoke name="read_skill_file">
 * <parameter name="file">human-writing/SKILL.md</parameter>
 * </invoke>
 * </tool_calls>
 * ```
 *
 * 不认它的话，这段 XML 会原样被当成这一阶段的正文存下来。
 * 那一阶段的产出是「材料解读」——存进去一段工具调用，
 * 后面每一道工序都拿着它当素材，模型只好回你一句「我这边没有拿到材料」。
 * 这条路正是作者那两三个字原话要走的工序，不能在这儿断掉。
 *
 * 认出来之后照常执行工具、把结果喂回去，循环继续走。
 */
export function parseTextToolCalls(content: string): {
  calls: ChatToolCall[];
  /** 去掉工具调用那段之后的正文（通常只剩空串）。 */
  stripped: string;
} | null {
  if (!content || !content.includes("<invoke")) return null;

  const calls: ChatToolCall[] = [];
  const invokePattern = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  let match = invokePattern.exec(content);
  while (match) {
    const name = match[1].trim();
    const body = match[2] ?? "";
    const args: Record<string, unknown> = {};
    const paramPattern = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
    let param = paramPattern.exec(body);
    while (param) {
      args[param[1].trim()] = decodeEntities(param[2] ?? "").trim();
      param = paramPattern.exec(body);
    }
    if (name) {
      calls.push({
        id: `call_text_${calls.length + 1}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
    }
    match = invokePattern.exec(content);
  }

  if (!calls.length) return null;
  // 把工具调用那段从正文里摘掉：它是调用，不是这一阶段要交付的东西。
  const stripped = content
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
    .replace(invokePattern, "")
    .trim();
  return { calls, stripped };
}

/** XML 里那几个常用实体的还原。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 一次模型请求的计时。
 *
 * 写长文动辄十几分钟，界面上只有一个转圈的圈，
 * 用户不知道慢在生成还是慢在补写。把每次请求的耗时记下来，
 * 阶段结束时汇总，界面就能说清楚「生成 5 分 12 秒，其中补写 3 分 40 秒」。
 */
export type LlmTiming = {
  /** 请求标签：正文生成、按节补写、按句改写…… */
  label: string;
  /** 这次请求花了多少毫秒。 */
  ms: number;
  /** 有没有拿到正文。 */
  ok: boolean;
  /** 输出 token 数。 */
  completionTokens?: number;
  /** 花在思考上的 token 数。 */
  reasoningTokens?: number;
};

/**
 * 计时记录。
 *
 * 放在模块里而不是挂在参数上：模型调用散在各个阶段里，
 * 传一个收集器下去要改一长串签名，不值得。
 */
const timings: LlmTiming[] = [];

/** 取走并清空计时记录。 */
export function drainLlmTimings(): LlmTiming[] {
  return timings.splice(0, timings.length);
}

/**
 * 发一次对话请求。
 *
 * 失败一律抛 LlmError，并尽量把服务端说了什么带进 detail——
 * 「模型名不对」「余额不足」「被限流」在 HTTP 层面都可能是 400，
 * 不看响应体就分不清。
 */
export async function chat(options: ChatOptions): Promise<ChatResult> {
  const label = options.label ?? "模型请求";
  const startedAt = Date.now();
  try {
    let result = await requestChatWithConfig(options);

    // 退化重复兜底：真模型偶发「可以可以可以…」刷屏（每行一个、几十行）。
    // 这是采样故障，不是提示词问题——先抬高温度重抽一次；仍然坏就明确报错，
    // 绝不能把这种文本当正文存下来。补救指令只在失败后追加，不污染正常路径。
    if (findDegenerateRepetition(result.content)) {
      result = await requestChatWithConfig({
        ...options,
        temperature: Math.min(1.2, (options.temperature ?? 0.7) + 0.2),
        retries: 0,
        messages: [
          ...options.messages,
          {
            role: "user",
            content:
              "上一次输出出现了退化重复（同一句或同一个词连续重复）。请完整重新生成这一阶段的产出，不要重复任何句子或词组。",
          },
        ],
      });
      if (findDegenerateRepetition(result.content)) {
        throw new LlmError(
          "模型输出出现了退化重复（同一句连续重复），已停止本次生成。请重试，或换一个模型 / 降低思考强度。",
        );
      }
    }

    timings.push({
      label,
      ms: Date.now() - startedAt,
      ok: Boolean(result.content.trim()),
      ...(typeof result.usage?.completionTokens === "number" ? { completionTokens: result.usage.completionTokens } : {}),
      ...(typeof result.usage?.reasoningTokens === "number" ? { reasoningTokens: result.usage.reasoningTokens } : {}),
    });
    return result;
  } catch (error) {
    timings.push({ label, ms: Date.now() - startedAt, ok: false });
    throw error;
  }
}

/** 读配置、发请求、加上额度与限流两重退避。 */
async function requestChatWithConfig(options: ChatOptions): Promise<ChatResult> {
  const config = await readAgentConfig();
  if (!config.apiKey?.trim()) {
    throw new LlmError("尚未配置模型 API Key。请到「模型」页面填入密钥后再试。");
  }
  if (!options.messages.length) {
    throw new LlmError("没有可发送的消息。");
  }

  const url = `${config.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return withBudgetRetry(
    (budget, attempt) =>
      withRateLimitRetry(() => requestChat(url, config, options, budget, timeoutMs, attempt)),
    baseMaxTokens,
    {
      // 本次请求指定的思考强度优先于模型配置里的。
      reasoningEffort: options.reasoningEffort ?? config.reasoningEffort,
      reasoningEffortSupported: !reasoningEffortUnsupported,
      // 这一次最多重试几遍。
      retries: options.retries,
    },
  );
}

/** 值得退避重试的状态码：限流与网关临时不可用。 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export type RateLimitRetryOptions = {
  /** 最多重试几次，默认 4 次。 */
  retries?: number;
  /** 第一次退避多少毫秒，之后指数翻倍，默认 5000。 */
  baseDelayMs?: number;
  /** 等待函数，测试里可以注入假的，免得真等。 */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 限流时退避重试。
 *
 * 带 RPM/TPM 限制的服务商（SenseNova、各家云厂商的免费额度都是）在长文生成时
 * 必然触发 429。直接报错等于让整篇稿子作废——用户等了几分钟，
 * 屏幕上却是一句「模型服务返回 HTTP 429」。
 *
 * 只对限流与网关类错误退避：4xx 的其他错误（模型名写错、key 无效）重试也没用，
 * 只会让用户白等。
 */
export async function withRateLimitRetry<T>(
  request: () => Promise<T>,
  options: RateLimitRetryOptions = {},
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 4);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 5_000);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  for (;;) {
    try {
      return await request();
    } catch (error) {
      const status = error instanceof LlmError ? error.status : undefined;
      if (status === undefined || !RETRYABLE_STATUS.has(status) || attempt >= retries) throw error;
      attempt += 1;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

/** 真正发出去的那一次请求。额度由调用方决定，方便外面加重试。 */
async function requestChat(
  url: string,
  config: { apiKey: string; model: string; temperature?: number; reasoningEffort?: string },
  options: ChatOptions,
  maxTokens: number,
  timeoutMs: number,
  attempt: RetryAttempt = { temperatureDelta: 0, index: 0 },
  sendReasoningEffort = true,
): Promise<ChatResult> {
  const { signal, dispose } = linkSignals(timeoutMs, options.signal);
  // 端点明确说过不认 reasoning_effort 之后，就不再发这个字段了。
  const effort = attempt.reasoningEffort ?? config.reasoningEffort;
  const sendEffort = sendReasoningEffort && Boolean(effort) && !reasoningEffortUnsupported;
  // 重试时把温度往上抬一点，逼端点换一条采样路径，
  // 而不是拿着同一把尺子量出同一个结果。
  const baseTemperature = options.temperature ?? config.temperature;
  const temperature =
    baseTemperature === undefined ? undefined : baseTemperature + attempt.temperatureDelta;

  try {
    // fetch 自己抛的 TypeError 只有一句 "fetch failed"，直接透到界面上等于没说。
    // 网络不通、代理没开、地址写错，都长这个样子，这里统一换成能照着排查的话。
    let response: Response;
    try {
      response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: options.messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        // 思考强度：不配置就不带这个字段（很多端点不认，带了会 400）。
        ...(sendEffort ? { reasoning_effort: effort } : {}),
        ...(options.tools?.length
          ? {
              tools: options.tools,
              tool_choice: options.toolChoice ?? "auto",
            }
          : {}),
      }),
      signal,
      });
    } catch (error) {
      dispose();
      throw new LlmError(
        "连不上模型服务：请检查「模型」页面填的地址是否正确、本机网络或代理是否可用。",
        { detail: error instanceof Error ? error.message : String(error) },
      );
    }

    const text = await response.text();

    if (!response.ok) {
      const detail = text.slice(0, 500).replace(/\s+/g, " ").trim();
      // 端点不认 reasoning_effort（返回 400/422）：去掉它再来一次。
      // 放在这里而不是上层，是因为上层把 400 一律当成「不支持工具调用」，
      // 那样会为了一个无关字段把工具也丢了，技能这一环就白搭了。
      if ((response.status === 400 || response.status === 422) && sendEffort) {
        // 错误里点名了 reasoning_effort，才认定是这个字段的问题。
        // 否则可能是别的参数写错了，不能赖到这个字段头上。
        if (/reasoning[._]?effort/i.test(text)) reasoningEffortUnsupported = true;
        dispose();
        return requestChat(url, config, options, maxTokens, timeoutMs, attempt, false);
      }
      throw new LlmError(`模型服务返回 HTTP ${response.status}`, { status: response.status, detail });
    }

    let body: {
      choices?: {
        message?: { content?: string; reasoning?: string; tool_calls?: unknown };
        finish_reason?: string;
      }[];
      model?: string;
      usage?: unknown;
      error?: { message?: string };
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new LlmError("模型服务返回的不是合法 JSON。", { status: response.status, detail: text.slice(0, 500) });
    }

    if (body.error?.message) {
      throw new LlmError(`模型服务报错：${body.error.message}`, { status: response.status });
    }
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      throw new LlmError("模型服务没有返回任何候选结果，请检查模型名是否正确。", {
        status: response.status,
        detail: text.slice(0, 500),
      });
    }

    const choice = body.choices[0];
    const toolCalls = normalizeToolCalls(choice?.message?.tool_calls);
    const reasoning = choice?.message?.reasoning;
    const rawContent = choice?.message?.content ?? "";
    // 有些端点不返回结构化的 tool_calls，而是把调用写成正文。
    // 不认它，这段 XML 就会被当成这一阶段的正文存下来——
    // 材料解读存进去的是一段工具调用，后面每一道工序都拿着它当素材，
    // 模型只好回一句「我这边没有拿到材料」（真模型实测，SenseNova 6.8）。
    const textual = toolCalls.length ? null : parseTextToolCalls(rawContent);
    const effectiveCalls = toolCalls.length ? toolCalls : textual?.calls ?? [];
    return {
      // content 为空串是合法情况（例如模型只返回了 tool_calls），不当成错误。
      content: textual ? textual.stripped : rawContent,
      model: body.model ?? config.model,
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      ...(effectiveCalls.length ? { toolCalls: effectiveCalls } : {}),
      ...(normalizeUsage(body.usage) ? { usage: normalizeUsage(body.usage)! } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      // abort 的 reason 已经被包装成 LlmError 时走上面的分支；
      // 这里是外部主动取消或环境差异导致的裸 AbortError。
      throw new LlmError("模型请求已取消。");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new LlmError(`模型请求失败：${message}`);
  } finally {
    dispose();
  }
}

/** 工具处理函数：收到工具名与参数，返回给模型看的结果文本。 */
export type ToolContext = {
  /** 到目前为止的完整对话，模型自己刚写的草稿也在里面。 */
  messages: ChatMessage[];
};

export type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
  context?: ToolContext,
) => Promise<string> | string;

export type ChatWithToolsOptions = ChatOptions & {
  /** 本次可用的工具。 */
  tools: ChatTool[];
  /** 执行工具调用。 */
  handler: ToolHandler;
  /** 最多允许几轮工具调用，防止模型绕圈。 */
  maxRounds?: number;
};

export type ChatWithToolsResult = ChatResult & {
  /** 模型实际发起过工具调用。 */
  toolsUsed: boolean;
  /** 端点不支持工具调用，已降级成普通对话。 */
  degraded: boolean;
  /** 模型反复调用工具没收尾，上面是它写的最后一版。 */
  toolLoopExhausted?: boolean;
};

/**
 * 输出被上限截断时，把额度加倍重试。
 *
 * 带思考的端点（reasoning / thinking）会把 max_tokens 花在思考上，
 * 正文可能一个字都没剩下——用户看到的是「生成成功，但内容是空的」。
 * 这种情况加大额度再来一次，比把半截稿子交出去强。
 *
 * 两个不能丢的东西：
 * - 重试的那一次自己也失败（超时、断网）时，交回上一版的半成品，
 *   而不是把已经写出来的字一起丢掉；
 * - 截断本身要如实报出去（finish_reason 仍然是 length），界面才知道
 *   这篇是半截的。
 *
 * 单独抽出来是为了能直接测：真模型跑一轮要一两分钟，测试不能靠等。
 */
/**
 * 一次重试的具体打法。
 *
 * 重试不是「原样再来一遍」——同一个端点、同样的提示词，
 * 上一次陷进思考螺旋，下一次照样陷进去（angle 阶段连着三次 0 正文就是这么来的）。
 * 换一种打法才有意义：换思考强度、换采样温度。
 */
export type RetryAttempt = {
  /** 本次要发的思考强度。undefined 表示沿用配置里的。 */
  reasoningEffort?: string;
  /** 本次相对配置温度要加的量。 */
  temperatureDelta: number;
  /** 第几次尝试，从 0 开始。 */
  index: number;
};

/**
 * 输出被上限截断时怎么处理。
 *
 * 三种截断要分开对待，这是真模型跑出来的教训：
 *
 * 1. **写了一半**（有内容、finish_reason=length）：额度确实不够，
 *    加倍重来一次是合理的。
 * 2. **一个字都没有**（无内容、finish_reason=length）：额度全被思考吃掉了。
 *    这时候加倍是在喂思考，不是在喂正文——探针里 8192 加倍到 16384，
 *    16384 个 token 全进了思考，正文依然是空的。
 *    这种情况下要**换策略**：先把思考强度降到 none 让它别想，
 *    再把温度抬高一档换一条采样路径。
 * 3. **根本没交出内容**（finish_reason 不是 length 但正文是空的）：
 *    同样按换策略处理。
 *
 * 换个策略的顺序也是定的：先降思考强度（这个端点上最有效，
 * 实测 none 一定能交出正文），再抬温度。
 */
export type BudgetRetryOptions = {
  /** 最多重试几次，默认 2。 */
  retries?: number;
  /** 配置里设的思考强度。没设就是空。 */
  reasoningEffort?: string;
  /** 端点认不认 reasoning_effort。不认就换不了策略，只能抬温度。 */
  reasoningEffortSupported?: boolean;
};

export async function withBudgetRetry(
  request: (maxTokens: number, attempt: RetryAttempt) => Promise<ChatResult>,
  baseMaxTokens: number,
  options: BudgetRetryOptions = {},
): Promise<ChatResult> {
  const retries = Math.max(0, options.retries ?? 2);
  let budget = Math.max(1, baseMaxTokens);
  let result: ChatResult | undefined;

  // 当前这一轮的打法。改打法要等到看清上一轮的结果之后才能决定，
  // 所以放在循环外面，每轮开头再传给请求。
  let effort = options.reasoningEffort;
  let delta = 0;
  // 陷进思考螺旋的次数。用来给温度递进。
  let spirals = 0;

  for (let index = 0; index <= retries; index++) {
    const attempt: RetryAttempt = { reasoningEffort: effort, temperatureDelta: delta, index };
    try {
      result = await request(budget, attempt);
    } catch (error) {
      // 重试失败：还有上一版就交回去。
      if (result) return result;
      throw error;
    }
    if (index === retries) return result;

    const empty = !result.content.trim();
    // 空正文不管 finish_reason 是什么都要换打法重来。
    // 之前这里只在 finish_reason=length 时才换，结果踩过一次坑：
    // 真模型补写时返回的是「空正文 + finish_reason=stop」，
    // 于是重试根本没触发，六次补写有五次交回一句「额度全花在思考上了」。
    // 注释里写的三种截断要分开对待，代码也得照着做。
    if (!empty && result.finishReason !== "length") return result;

    if (!empty) {
      // 写了一半：额度确实不够，加倍重来，打法照旧。
      budget = budget * 2;
      continue;
    }

    // 一个字都没交出来：额度全被思考吃光了。
    // 加倍没用（8192 加倍到 16384，16384 个 token 全进了思考，正文依然是空的），
    // 只能换打法：把思考强度降下来，再把温度抬高一档换一条采样路径。
    spirals += 1;
    effort = nextEffort(options, effort);
    delta = 0.15 * spirals;
  }
  // 循环必然执行过至少一次，这里只是让类型检查满意。
  return result!;
}

/**
 * 空内容之后，下一轮该用哪个思考强度。
 *
 * **换的是「跟刚才不一样的那个」，不是固定往一个方向降。**
 *
 * 这两个强度各有各的适用范围，而且都会翻车：
 *
 * | 形状 | `none` | `minimal` |
 * | --- | --- | --- |
 * | 一次性写正文（SenseNova 6.8） | 思考吃满 8192、正文 0 汉字 | 思考 257、正文 984 字、9.7 秒 |
 * | 按节补写 | 思考 3005、正文 74 字 | 思考吃满 8192、正文 0 汉字 |
 *
 * （同一份提示词、同一份额度，只换这一个变量。）
 *
 * 所以「空了就降到 none」是错的：那样会把一次性正文推进 none 的坑里。
 * 正确的做法是换一个**没试过的**强度，再抬温度换一条采样路径——
 * 两个强度轮着来，总有一个是这个形状能用的。
 *
 * 端点明确不认这个字段就别换，换了也只会换来 400。
 */
function nextEffort(options: BudgetRetryOptions, current?: string): string | undefined {
  if (options.reasoningEffortSupported === false) return options.reasoningEffort;
  return current === "none" ? "minimal" : "none";
}

/** 工具循环的输入。ask 由调用方实现，方便测试时用假模型顶替。 */
export type ToolLoopOptions = {
  /** 初始对话（系统提示 + 历史 + 本次输入）。 */
  messages: ChatMessage[];
  /** 让模型说话一次。 */
  ask: (messages: ChatMessage[]) => Promise<ChatResult>;
  /** 工具处理函数。 */
  handler: ToolHandler;
  /** 最多允许几轮工具调用。 */
  maxRounds?: number;
};

export type ToolLoopResult = {
  content: string;
  toolsUsed: boolean;
  /** 轮次用完时模型还没收尾。 */
  toolLoopExhausted: boolean;
  model?: string;
  finishReason?: string;
  usage?: ChatUsage;
};

/**
 * 工具调用循环。
 *
 * 模型要调工具 → 执行 → 把结果作为 tool 消息回给它 → 继续，直到它不再要工具。
 *
 * 三个真模型跑出来的教训，都在这里落地：
 * 1) 模型可能把同一个工具同样的参数连着调好几次——重复的调用不重复执行，
 *    直接告诉它「结果在上面，别再调了」，否则它会绕圈。
 * 2) 轮次用完不等于失败。模型很可能已经把稿子写出来了（只是塞在工具参数里，
 *    或者某一轮返回过正文）。这时候把最后一版交回去并标记没收尾，
 *    比抛错让整篇稿子消失强得多。
 * 3) 最后一轮之前提醒模型收尾，别把工具调用用到天荒地老。
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? 6);
  const messages: ChatMessage[] = [...options.messages];
  let toolsUsed = false;
  let lastContent = "";
  let model = "";
  let usage: ChatUsage | undefined;
  const callCounts = new Map<string, number>();

  for (let round = 0; round <= maxRounds; round++) {
    const result = await options.ask(messages);
    model = result.model || model;
    usage = result.usage || usage;
    if (result.content.trim()) lastContent = result.content;

    const calls = result.toolCalls ?? [];
    if (!calls.length) {
      return {
        content: result.content,
        toolsUsed,
        toolLoopExhausted: false,
        ...(model || result.model ? { model: model || result.model } : {}),
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(usage ? { usage } : {}),
      };
    }

    toolsUsed = true;
    messages.push({ role: "assistant", content: result.content, tool_calls: calls });

    for (const call of calls) {
      const fingerprint = `${call.function.name}|${call.function.arguments}`;
      const times = (callCounts.get(fingerprint) ?? 0) + 1;
      callCounts.set(fingerprint, times);

      let output: string;
      if (times > 1) {
        // 同一个调用又来了一次：多半是模型陷进了循环。
        // 不重复执行，结果就在上面的对话里。
        output = `你已经调用过 ${call.function.name}（同样的参数），结果在上面，不要重复调用。`;
        if (times >= 2) output += "如果内容已经够了，请直接给出最终稿，不要再调工具。";
      } else {
        try {
          const args = call.function.arguments
            ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
            : {};
          output = await options.handler(call.function.name, args, { messages });
        } catch (error) {
          // 工具出错也要回给模型，让它知道这条路走不通，而不是让它干等。
          output = `工具 ${call.function.name} 调用失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      messages.push({ role: "tool", content: output, tool_call_id: call.id });
    }

    // 最后一轮之前提醒收尾。
    if (round === maxRounds - 1) {
      messages.push({ role: "user", content: "不要再调用工具了。请直接输出这一阶段的最终结果。" });
    }
  }

  return {
    content: lastContent,
    toolsUsed,
    toolLoopExhausted: true,
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * 带工具的对话。
 *
 * 端点不支持 tools 时降级成普通对话：出稿比报错重要，
 * 但调用方要知道技能这一环没生效（结果里的 degraded 为 true）。
 */
export async function chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
  const initial = [...options.messages];
  let degraded = false;

  const ask = async (current: ChatMessage[]): Promise<ChatResult> => {
    try {
      return await chat({ ...options, messages: current, tools: options.tools });
    } catch (error) {
      // 有些兼容端点不带工具时会直接 400。第一次就降级：去掉工具再问一次。
      const isFirstRound = current.length === initial.length;
      if (isFirstRound && error instanceof LlmError && error.status === 400) {
        degraded = true;
        return chat({ ...options, messages: current, tools: undefined });
      }
      throw error;
    }
  };

  const loop = await runToolLoop({
    messages: initial,
    ask,
    handler: options.handler,
    maxRounds: options.maxRounds,
  });

  if (degraded) {
    return {
      content: loop.content,
      model: loop.model ?? "",
      ...(loop.usage ? { usage: loop.usage } : {}),
      toolsUsed: false,
      degraded: true,
    };
  }

  return {
    content: loop.content,
    model: loop.model ?? "",
    ...(loop.finishReason ? { finishReason: loop.finishReason } : {}),
    ...(loop.usage ? { usage: loop.usage } : {}),
    toolsUsed: loop.toolsUsed,
    degraded: false,
    ...(loop.toolLoopExhausted ? { toolLoopExhausted: true } : {}),
  };
}
