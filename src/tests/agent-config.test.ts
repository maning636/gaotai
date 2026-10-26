import { writeFileSync } from "node:fs";
import { assertEqual, assertTrue, suite } from "./harness";
import {
  _encryptApiKey,
  readAgentConfig,
  writeAgentConfig,
  type AgentConfigPublic,
} from "../lib/agent-config-store";
import { agentConfigFile, envFile } from "../lib/paths";
import { chat } from "../lib/llm";

// 密钥的加密口令来自数据目录里的 .env。测试沙箱里没有这个文件，
// 密文就解不开（解不开时 key 当成空，chat() 直接拒绝发请求）。
//
// 注意：这一步必须放在用例里，不能放模块顶层——run-all.ts 是先执行全部静态 import、
// 才设置 GAOTAI_DATA_DIR 指向沙箱的。模块顶层调用 envFile() 拿到的是
// 进程工作目录（真实项目目录），会把项目根的 .env 覆盖掉。
const SECRET = "test-session-secret-for-gaotai-only";

function ensureEnv() {
  writeFileSync(envFile(), `SESSION_SECRET=${SECRET}\n`, "utf8");
}

/**
 * 「思考强度」这个参数是接真模型时逼出来的：
 * 带思考的端点把 max_tokens 当「思考 + 正文」的总额度，思考占满了正文就是空的
 * （真模型实测：SenseNova 6.8 连续撞上限，正文一个字都没有）。
 */
suite("模型配置：思考强度", ({ test }) => {
  test("保存后能读回来", async () => {
    ensureEnv();
    await writeAgentConfig({ reasoningEffort: "none" });
    const config = await readAgentConfig();
    assertEqual(config.reasoningEffort, "none");
  });

  test("空值表示不设这个参数", async () => {
    ensureEnv();
    await writeAgentConfig({ reasoningEffort: "low" });
    await writeAgentConfig({ reasoningEffort: "" });
    const config = await readAgentConfig();
    assertEqual(config.reasoningEffort, undefined);
  });

  test("非法取值会被拒", async () => {
    ensureEnv();
    let threw = false;
    try {
      await writeAgentConfig({ reasoningEffort: "turbo" as never });
    } catch {
      threw = true;
    }
    assertTrue(threw, "不认识的思考强度不该被存进去");
  });

  test("对外暴露的配置里带着这个字段", async () => {
    ensureEnv();
    await writeAgentConfig({ reasoningEffort: "medium" });
    const config = await readAgentConfig();
    const publicView: AgentConfigPublic = { ...config, apiKeyMasked: "••••••••" };
    assertEqual(publicView.reasoningEffort, "medium");
  });
});

suite("模型请求：思考强度怎么发", ({ test }) => {
  const originalFetch = globalThis.fetch;

  function writeConfig(reasoningEffort: string) {
    ensureEnv();
    writeFileSync(
      agentConfigFile(),
      JSON.stringify({
        model: "m",
        apiBaseUrl: "https://example.invalid/v1",
        apiKeyEncrypted: _encryptApiKey("k", SECRET),
        systemPrompt: "",
        temperature: 0.7,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }),
      "utf8",
    );
  }

  test("配置了就带上这个字段", async () => {
    writeConfig("none");
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "好" }, finish_reason: "stop" }], model: "m" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await chat({ messages: [{ role: "user", content: "写" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEqual(sent.reasoning_effort, "none");
  });

  test("没配置就不带这个字段", async () => {
    writeConfig("");
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "好" }, finish_reason: "stop" }], model: "m" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await chat({ messages: [{ role: "user", content: "写" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEqual(sent.reasoning_effort, undefined);
  });

  test("端点不认这个字段时，去掉它再试一次", async () => {
    writeConfig("none");
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "unknown field" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "好" }, finish_reason: "stop" }], model: "m" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = await chat({ messages: [{ role: "user", content: "写" }] });
      assertEqual(result.content, "好");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEqual(bodies.length, 2);
    assertEqual(bodies[0].reasoning_effort, "none");
    assertEqual(bodies[1].reasoning_effort, undefined, "重试时不该再带这个字段");
  });
});
