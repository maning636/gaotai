import { assertEqual, assertTrue, suite } from "./harness";
import {
  LlmError,
  parseTextToolCalls,
  runToolLoop,
  withBudgetRetry,
  withRateLimitRetry,
  type ChatResult,
} from "../lib/llm";

/**
 * 真模型跑出来之后补的三条行为。
 *
 * 之前这些逻辑散在 chatWithTools 里，既不好测，出问题时也没法定位：
 * - 思考型模型把 max_tokens 吃光 → 正文一个字都没有（真模型实测，outline 阶段产出 0 字）；
 * - 模型把同一个工具同样的参数连着调 → 绕圈，直到轮次耗尽；
 * - 轮次耗尽直接抛错 → 模型已经写好的稿子被整篇丢掉（真模型实测，正文阶段 500）。
 */

function toolCall(name: string, args: unknown, id: string) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

suite("额度重试", ({ test }) => {
  test("输出被上限截断时额度加倍重来一次", async () => {
    const budgets: number[] = [];
    const result = await withBudgetRetry(
      async (maxTokens) => {
        budgets.push(maxTokens);
        if (budgets.length === 1) {
          return { content: "写了一半", model: "m", finishReason: "length" } satisfies ChatResult;
        }
        return { content: "写出来了", model: "m", finishReason: "stop" } satisfies ChatResult;
      },
      4096,
    );
    assertEqual(budgets, [4096, 8192]);
    assertEqual(result.content, "写出来了");
  });

  test("一个字都没交出来时按同样的额度重采样，不加倍", async () => {
    // 真模型实测：带思考的端点会把 max_tokens 全花在思考上，正文一个字没有。
    // 这时候加倍额度是在喂思考，不是在喂正文——探针里 8192 加倍到 16384，
    // 16384 个 token 全进了思考，正文依然是空的。
    // 管用的办法是同样的额度换个样本再采样：同一个端点，上一次能交出稿子下一次也能。
    const budgets: number[] = [];
    const result = await withBudgetRetry(
      async (maxTokens) => {
        budgets.push(maxTokens);
        return { content: "", model: "m", finishReason: "length" } satisfies ChatResult;
      },
      4096,
    );
    assertEqual(budgets, [4096, 4096, 4096], "额度不变，重采样两次");
    assertEqual(result.content, "");
  });

  test("空内容重试要换策略：先降思考强度，再抬温度换采样", async () => {
    // 真模型实测：angle 阶段带着 minimal 连着三次 0 正文，同一条请求单独打却一次就成了。
    // 说明这个端点会随机陷进思考螺旋，原样重采样不够，得换打法。
    const plans: { effort?: string; delta: number }[] = [];
    const result = await withBudgetRetry(
      async (_maxTokens, attempt) => {
        plans.push({ effort: attempt.reasoningEffort, delta: attempt.temperatureDelta });
        if (plans.length === 1) {
          return { content: "", model: "m", finishReason: "length" } satisfies ChatResult;
        }
        return { content: "这次写出来了", model: "m", finishReason: "stop" } satisfies ChatResult;
      },
      4096,
      { reasoningEffort: "minimal", reasoningEffortSupported: true },
    );
    assertEqual(plans[0].effort, "minimal", "第一次沿用配置里的思考强度");
    assertEqual(plans[0].delta, 0, "第一次不改温度");
    assertEqual(plans[1].effort, "none", "空内容之后把思考强度降到 none");
    assertTrue(plans[1].delta > 0, "空内容之后要把温度抬高一档换采样");
    assertEqual(result.content, "这次写出来了");
  });

  test("空正文 + finish_reason=stop 也要换策略重来", async () => {
    // 真模型实测（2026-10-22 夜）：正文阶段补写时，模型交回的是
    // 「空正文 + finish_reason=stop」，不是 length。
    // 旧代码只在 finish_reason=length 时才换打法，于是重试根本没触发，
    // 六次补写有五次空着回来，稿子一直短着。
    const plans: { effort?: string; delta: number }[] = [];
    const result = await withBudgetRetry(
      async (_maxTokens, attempt) => {
        plans.push({ effort: attempt.reasoningEffort, delta: attempt.temperatureDelta });
        if (plans.length === 1) {
          return {
            content: "",
            model: "m",
            finishReason: "stop",
            usage: { reasoningTokens: 2000 },
          } satisfies ChatResult;
        }
        return { content: "这次写出来了", model: "m", finishReason: "stop" } satisfies ChatResult;
      },
      4096,
      { reasoningEffort: "minimal", reasoningEffortSupported: true },
    );
    assertEqual(plans.length, 2, "空正文必须重试一次");
    assertEqual(plans[1].effort, "none", "空正文之后把思考强度降到 none");
    assertTrue(plans[1].delta > 0, "空正文之后要把温度抬高一档换采样");
    assertEqual(result.content, "这次写出来了");
  });

  test("空正文也不加倍额度（加倍是在喂思考）", async () => {
    const budgets: number[] = [];
    await withBudgetRetry(
      async (maxTokens) => {
        budgets.push(maxTokens);
        return {
          content: "",
          model: "m",
          finishReason: "stop",
          usage: { reasoningTokens: 2000 },
        } satisfies ChatResult;
      },
      4096,
    );
    assertEqual(budgets, [4096, 4096, 4096], "额度不变，只换打法");
  });

  test("端点不认 reasoning_effort 时不换强度，只靠抬温度换采样", async () => {
    const plans: { effort?: string; delta: number }[] = [];
    await withBudgetRetry(
      async (_maxTokens, attempt) => {
        plans.push({ effort: attempt.reasoningEffort, delta: attempt.temperatureDelta });
        return { content: "", model: "m", finishReason: "length" } satisfies ChatResult;
      },
      4096,
      { reasoningEffort: "minimal", reasoningEffortSupported: false },
    );
    assertEqual(plans[1].effort, "minimal", "端点不认这个字段就别换，换了只会换来 400");
    assertTrue(plans[1].delta > 0, "还是要抬温度换采样");
    assertTrue(plans[2].delta > plans[1].delta, "两次重试的温度要递进");
  });

  test("没配思考强度时，空内容之后主动用 none 兜底", async () => {
    const plans: { effort?: string }[] = [];
    await withBudgetRetry(
      async (_maxTokens, attempt) => {
        plans.push({ effort: attempt.reasoningEffort });
        return { content: "", model: "m", finishReason: "length" } satisfies ChatResult;
      },
      4096,
      { reasoningEffortSupported: true },
    );
    assertEqual(plans[0].effort, undefined, "没配就不发这个字段");
    assertEqual(plans[1].effort, "none", "空内容之后用 none 兜底");
  });

  test("重采样一次就交出正文时，不再继续重试", async () => {
    const budgets: number[] = [];
    const result = await withBudgetRetry(
      async (maxTokens) => {
        budgets.push(maxTokens);
        if (budgets.length === 1) {
          return { content: "", model: "m", finishReason: "length" } satisfies ChatResult;
        }
        return { content: "这次写出来了", model: "m", finishReason: "stop" } satisfies ChatResult;
      },
      4096,
    );
    assertEqual(budgets, [4096, 4096]);
    assertEqual(result.content, "这次写出来了");
  });

  test("没撞上限就不重试", async () => {
    let calls = 0;
    const result = await withBudgetRetry(async () => {
      calls += 1;
      return { content: "一次就成", model: "m", finishReason: "stop" } satisfies ChatResult;
    }, 4096);
    assertEqual(calls, 1);
    assertEqual(result.content, "一次就成");
  });

  test("一直撞上限时最多重试两次", async () => {
    const budgets: number[] = [];
    await withBudgetRetry(
      async (maxTokens) => {
        budgets.push(maxTokens);
        return { content: "写了一半", model: "m", finishReason: "length" } satisfies ChatResult;
      },
      1024,
    );
    assertEqual(budgets, [1024, 2048, 4096]);
  });

  test("重试自己失败时，交回上一版半成品而不是报错", async () => {
    let calls = 0;
    const result = await withBudgetRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          return { content: "写了一半", model: "m", finishReason: "length" } satisfies ChatResult;
        }
        throw new Error("超时了");
      },
      4096,
    );
    assertEqual(result.content, "写了一半");
    assertEqual(result.finishReason, "length");
  });

  test("第一次就失败时照实报错", async () => {
    let threw = false;
    try {
      await withBudgetRetry(async () => {
        throw new Error("连不上");
      }, 4096);
    } catch (error) {
      threw = true;
      assertTrue(error instanceof Error && error.message === "连不上");
    }
    assertTrue(threw, "第一次就失败时不能被吞掉");
  });
});

suite("限流退避", ({ test }) => {
  test("被限流时退避后重试并拿到结果", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new LlmError("模型服务返回 HTTP 429", { status: 429 });
        return "写出来了";
      },
      { retries: 3, baseDelayMs: 1000, sleep: async (ms) => { delays.push(ms); } },
    );
    assertEqual(calls, 2);
    assertEqual(result, "写出来了");
    assertEqual(delays, [1000]);
  });

  test("退避时间指数翻倍", async () => {
    const delays: number[] = [];
    await withRateLimitRetry(
      async () => {
        throw new LlmError("限流", { status: 429 });
      },
      { retries: 3, baseDelayMs: 1000, sleep: async (ms) => { delays.push(ms); } },
    ).catch(() => undefined);
    assertEqual(delays, [1000, 2000, 4000]);
  });

  test("一直限流时按次数上限收手并报错", async () => {
    let calls = 0;
    let threw = false;
    try {
      await withRateLimitRetry(
        async () => {
          calls += 1;
          throw new LlmError("限流", { status: 429 });
        },
        { retries: 2, baseDelayMs: 1, sleep: async () => undefined },
      );
    } catch (error) {
      threw = true;
      assertTrue(error instanceof LlmError && error.status === 429);
    }
    assertTrue(threw, "限流到最后必须报错，不能一直挂着");
    assertEqual(calls, 3);
  });

  test("模型名写错这类 400 不退避，直接报错", async () => {
    let calls = 0;
    let threw = false;
    try {
      await withRateLimitRetry(
        async () => {
          calls += 1;
          throw new LlmError("模型服务返回 HTTP 400", { status: 400 });
        },
        { retries: 3, baseDelayMs: 1, sleep: async () => undefined },
      );
    } catch {
      threw = true;
    }
    assertTrue(threw);
    assertEqual(calls, 1, "400 重试没有意义，要一次就说清楚");
  });

  test("网关临时不可用（503）也退避", async () => {
    let calls = 0;
    const result = await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new LlmError("网关超时", { status: 503 });
        return "好了";
      },
      { retries: 2, baseDelayMs: 1, sleep: async () => undefined },
    );
    assertEqual(calls, 2);
    assertEqual(result, "好了");
  });
});

suite("工具调用循环", ({ test }) => {
  test("模型不再调工具时正常返回", async () => {
    const result = await runToolLoop({
      messages: [{ role: "user", content: "写吧" }],
      ask: async () => ({ content: "正文", model: "m", finishReason: "stop" }),
      handler: async () => "工具结果",
      maxRounds: 3,
    });
    assertEqual(result.content, "正文");
    assertEqual(result.toolsUsed, false);
    assertEqual(result.toolLoopExhausted, false);
  });

  test("同一个调用重复出现时只执行一次，并告诉模型别再调", async () => {
    let handlerCalls = 0;
    const toolResults: string[] = [];
    const result = await runToolLoop({
      messages: [{ role: "user", content: "写吧" }],
      ask: async (messages) => {
        // 前两轮都调同一个工具、同样的参数；第三轮交稿。
        const rounds = messages.filter(m => m.role === "tool").length;
        if (rounds < 2) {
          return {
            content: "",
            model: "m",
            finishReason: "tool_calls",
            toolCalls: [toolCall("read_skill_file", { file: "a/SKILL.md" }, `call_${rounds}`)],
          } satisfies ChatResult;
        }
        return { content: "写完了", model: "m", finishReason: "stop" } satisfies ChatResult;
      },
      handler: async () => {
        handlerCalls += 1;
        return "技能入口内容";
      },
      maxRounds: 4,
    });
    assertEqual(handlerCalls, 1, "重复的调用不该再执行一次");
    assertEqual(result.content, "写完了");
    assertEqual(result.toolsUsed, true);
    assertTrue(toolResults.length === 0);
  });

  test("轮次用完时交出最后一版正文，而不是抛错", async () => {
    const result = await runToolLoop({
      messages: [{ role: "user", content: "写吧" }],
      ask: async () => ({
        content: "",
        model: "m",
        finishReason: "tool_calls",
        toolCalls: [toolCall("check_prose", { text: "我写好的稿子" }, "call_x")],
      }),
      handler: async () => "体检结果",
      maxRounds: 2,
    });
    assertEqual(result.toolLoopExhausted, true);
    assertEqual(result.toolsUsed, true);
  });

  test("最后一轮之前会提醒模型收尾", async () => {
    const seen: string[][] = [];
    await runToolLoop({
      messages: [{ role: "user", content: "写吧" }],
      ask: async (messages) => {
        seen.push(messages.map(m => m.role));
        return {
          content: "",
          model: "m",
          finishReason: "tool_calls",
          toolCalls: [toolCall("check_prose", {}, `call_${seen.length}`)],
        } satisfies ChatResult;
      },
      handler: async () => "体检结果",
      maxRounds: 3,
    });
    assertTrue(seen.length >= 2);
    const last = seen[seen.length - 1];
    assertTrue(last.includes("user"), "收尾提醒要以 user 消息插进去");
  });

  test("模型写过正文时，正文不会因为没收尾而丢", async () => {
    const result = await runToolLoop({
      messages: [{ role: "user", content: "写吧" }],
      ask: async (messages) => {
        const rounds = messages.filter(m => m.role === "tool").length;
        if (rounds === 0) {
          return {
            content: "我写了一版正文",
            model: "m",
            finishReason: "tool_calls",
            toolCalls: [toolCall("check_prose", {}, "call_1")],
          } satisfies ChatResult;
        }
        return {
          content: "",
          model: "m",
          finishReason: "tool_calls",
          toolCalls: [toolCall("check_prose", {}, "call_2")],
        } satisfies ChatResult;
      },
      handler: async () => "体检结果",
      maxRounds: 1,
    });
    assertEqual(result.toolLoopExhausted, true);
    assertEqual(result.content, "我写了一版正文");
  });
});

/**
 * 模型把工具调用写进正文的那一种。
 *
 * 真模型实测（2026-10-23，SenseNova 6.8）：材料解读阶段没有返回结构化的
 * tool_calls，而是把调用写成了正文：
 *
 *   <tool_calls>
 *   <invoke name="read_skill_file">
 *   <parameter name="file">human-writing/SKILL.md</parameter>
 *   </invoke>
 *   </tool_calls>
 *
 * 不认它，这段 XML 就成了「材料解读」的正文，
 * 后面每一道工序都拿着它当素材，模型只好回一句「我这边没有拿到材料」。
 */
suite("正文里写的工具调用", ({ test }) => {
  test("认出来，并且把参数取出来", () => {
    const parsed = parseTextToolCalls(
      [
        "<tool_calls>",
        '<invoke name="read_skill_file">',
        '<parameter name="file">human-writing/SKILL.md</parameter>',
        "</invoke>",
        "</tool_calls>",
      ].join("\n"),
    );
    assertTrue(parsed !== null, "要认出来");
    assertEqual(parsed!.calls.length, 1);
    assertEqual(parsed!.calls[0].function.name, "read_skill_file");
    assertEqual(
      JSON.parse(parsed!.calls[0].function.arguments).file,
      "human-writing/SKILL.md",
    );
    assertEqual(parsed!.stripped, "", "工具调用那段不算正文");
  });

  test("正文前面带话时，话要留下", () => {
    const parsed = parseTextToolCalls(
      [
        "我先读一下技能文件。",
        '<invoke name="read_skill_file">',
        '<parameter name="file">human-writing/SKILL.md</parameter>',
        "</invoke>",
      ].join("\n"),
    );
    assertTrue(parsed !== null);
    assertEqual(parsed!.stripped, "我先读一下技能文件。");
  });

  test("没有工具调用就当普通正文", () => {
    assertEqual(parseTextToolCalls("这就是正文。"), null);
    assertEqual(parseTextToolCalls(""), null);
  });
});