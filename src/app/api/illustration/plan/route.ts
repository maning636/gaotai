import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { getStageResult } from "../../../../lib/repo";
import { chat, isLlmConfigured } from "../../../../lib/llm";
import { getPrompt, renderPrompt } from "../../../../lib/prompt-store";
import { sanitizePlan, articleCharCount, articleHasNumbers } from "../../../../lib/illustration-plan";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  projectId: z.string().trim().min(1).max(80),
});

/**
 * 全文自动配图：分析正文，给出配图计划。
 *
 * 走模型（提示词 resources/prompts/illustration-plan.md，六条规则写死在模板里），
 * 返回前经过三层防线：
 * 1. zod 校验模型整体输出（{ plan: [...] }）；
 * 2. 逐条校验 data 能通过 chartSpecSchema 且类型一致；
 * 3. 硬过滤（不依赖模型听话）：无数字正文丢 bar/waffle/kpi、
 *    段落号越界夹紧、同位置去重、超张数截断。
 *
 * 被丢弃的条目一律写进 warnings，不静默吞掉。
 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "参数不对";
    return NextResponse.json({ error: `计划参数不对：${message}` }, { status: 400 });
  }

  const project = getStageResult(body.projectId, "article");
  const article = project?.content ?? "";
  if (!article.trim()) {
    return NextResponse.json({ error: "正文还是空的，先写完正文再自动配图。" }, { status: 400 });
  }

  if (!(await isLlmConfigured())) {
    return NextResponse.json({ error: "尚未配置模型 API Key。请到「模型」页面填入密钥后再试。" }, { status: 400 });
  }

  const instruction = getPrompt("illustration-plan").trim();
  if (!instruction) {
    return NextResponse.json(
      {
        error:
          "自动配图提示词还没到位。请到「系统 → 授权」点「检查更新」同步资源包后重试。",
      },
      { status: 500 },
    );
  }

  const system = [
    `## 全局要求\n\n${renderPrompt(getPrompt("system"), {})}`.trim(),
    `## 本阶段要求\n\n${instruction}`.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

  const user = `请通读下面的文章全文，按规则输出配图计划：\n\n${article}`;

  let rawText: string;
  try {
    const result = await chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 4096,
      reasoningEffort: "none",
      label: "配图计划",
    });
    rawText = result.content.trim();
    if (!rawText) {
      return NextResponse.json({ error: "模型没有返回配图计划，请重试。" }, { status: 502 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成配图计划失败。";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // 模型可能把 JSON 包在 ```json ... ``` 里，剥掉。
  const jsonText = extractJson(rawText);

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return NextResponse.json(
      { error: "模型返回的配图计划不是合法 JSON，请重试。", warnings: [`原始返回：${rawText.slice(0, 200)}`] },
      { status: 502 },
    );
  }

  const { plan, warnings } = sanitizePlan(raw, article);

  return NextResponse.json({
    plan,
    warnings,
    articleLength: articleCharCount(article),
    hasNumbers: articleHasNumbers(article),
  });
}

/** 从模型输出里抠出 JSON：优先整段，否则找第一对 { } 到最后一对 }。 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}
