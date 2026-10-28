import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../lib/license/guard";
import {
  readAgentConfig,
  testAgentConnection,
  toPublic,
  writeAgentConfig,
} from "../../../lib/agent-config-store";

export const runtime = "nodejs";

const configSchema = z.object({
  model: z.string().trim().min(1).max(120),
  apiBaseUrl: z.string().trim().min(1).max(300).regex(/^https?:\/\//i, "API Base URL 必须以 http:// 或 https:// 开头。"),
  apiKey: z.string().max(1024).optional(),
  systemPrompt: z.string().max(8000).optional(),
  temperature: z.number().min(0).max(2),
  // 思考强度。空字符串 = 不传这个字段，跟随端点默认。
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "max"]).or(z.literal("")).optional(),
});

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test"), config: configSchema.partial().optional() }),
  z.object({ action: z.literal("save"), config: configSchema }),
]);

export async function GET() {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    const current = await readAgentConfig();
    return NextResponse.json({ config: toPublic(current) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取 LM 配置失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    if (body.action === "test") {
      const current = await readAgentConfig();
      // 用户在表单里清空 apiKey 想沿用旧值时，前端不传 key；
      // 这里保留 current.apiKey，同时允许用户覆盖 model/baseURL/prompt/temperature。
      const result = await testAgentConnection(current, body.config ?? {});
      return NextResponse.json({ ...result });
    }
    const saved = await writeAgentConfig(body.config);
    return NextResponse.json({ ok: true, message: "LM 配置已保存。", config: toPublic(saved) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存 LM 配置失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
