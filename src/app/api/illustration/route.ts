import { NextResponse } from "next/server";
import { requireAuth } from "../../../lib/auth";
import { chartSpecSchema } from "../../../lib/chart-spec";
import { renderChart } from "../../../lib/chart-renderer";

export const runtime = "nodejs";

/**
 * 生成文章图解（PNG）。
 *
 * 请求体就是一份 ChartSpec（kind + 标题 + 数据 + 可选单位/来源）。
 * 渲染成 2000px 宽 PNG 落到本地素材库，返回 `url` 供正文按光标插入。
 *
 * 为什么走图片而不是 HTML：公众号不执行 JS，ECharts/Chart.js 粘进去是死图；
 * 复杂 SVG 在部分客户端也会被吃掉。PNG 走已有的图片上传链路最稳。
 */
export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const parsed = chartSpecSchema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: `图解参数不对：${first?.path?.join(".") ?? ""} ${first?.message ?? ""}`.trim() },
      { status: 400 },
    );
  }

  try {
    const result = await renderChart(parsed.data);
    if (result.size > 1_500_000) {
      return NextResponse.json({ error: "生成的图太大（超过 1.5MB），请减少条目后重试。" }, { status: 413 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成图解失败。" },
      { status: 500 },
    );
  }
}
