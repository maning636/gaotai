import { chat } from "../llm";

/**
 * 从文章摘要提炼配图主题。
 *
 * 让模型读一段正文，输出 3-5 个适合做配图的主题关键词（JSON 数组）。
 * 走 src/lib/llm.ts 的 chat()（OpenAI 兼容 /chat/completions），
 * 密钥与模型名都来自模型配置，不在这里重复取。
 */

/** 提取主题的提示词。 */
const EXTRACT_PROMPT = `你是一位资深的配图编辑。请阅读下面这篇文章摘要，
提炼出 3 到 5 个最适合用来配图的主题关键词。

要求：
- 每个关键词是一个短语（2-8 个汉字），能独立成为一张配图的主体，例如「清晨的办公室」「城市天际线」「键盘特写」；
- 关键词要有画面感，避免抽象概念（如「效率」「增长」）和无法可视化的人名；
- 只输出 JSON 数组字符串，不要输出任何解释或 Markdown 代码块。`;

/**
 * 从正文提取配图主题。
 *
 * 解析失败时抛错，由调用方决定如何展示。
 */
export async function extractImageTopics(text: string): Promise<string[]> {
  const content = text.trim();
  if (!content) throw new Error("正文还是空的，先写完正文再提取主题。");

  const result = await chat({
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: content.slice(0, 20_000) },
    ],
    maxTokens: 1024,
    reasoningEffort: "none",
    label: "配图主题提取",
  });
  const raw = result.content.trim();
  if (!raw) throw new Error("模型没有返回主题，请重试。");

  // 模型可能把 JSON 包在 ```json ... ``` 里，剥掉。
  const jsonText = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("模型返回的主题不是合法 JSON，请重试。");
  }
  if (!Array.isArray(parsed)) throw new Error("模型返回的主题不是数组，请重试。");

  const topics = parsed
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(item => item.trim());
  // 只取前 6 个，避免模型撒一大把。
  return topics.slice(0, 6);
}

/** 从模型输出里抠出 JSON：优先整段，否则找第一对 [ 到最后一对 ]。 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const first = trimmed.indexOf("[");
  const last = trimmed.lastIndexOf("]");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}
