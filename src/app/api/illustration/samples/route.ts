import { NextResponse } from "next/server";
import { guard } from "../../../../lib/license/guard";
import { renderChartPng } from "../../../../lib/chart-renderer";
import type { ChartKind } from "../../../../lib/chart-spec";

export const runtime = "nodejs";

/**
 * 六种图型的真实缩略图（图例）。
 *
 * 界面上的图例卡片需要「每种图长什么样」，而不是只有一行文字。
 * 这里用每种图的最小示例 spec 渲染成 PNG，返回 base64 data URL。
 *
 * 输出尺寸：CSS 宽 900、倍率 1 → 900px 宽 PNG。
 * 缩略图只需 1x 就足够清楚（正文出图才用 2x 卡公众号 2000px 红线）。
 * 进程内 memo 缓存：同一进程内重复请求不再重渲染。
 */

/** 图例缩略图的 CSS 逻辑宽。 */
const SAMPLE_WIDTH = 900;
/** 图例缩略图的输出倍率（1x 足够清楚）。 */
const SAMPLE_SCALE = 1;

/** 每种图的最小示例 spec。 */
const SAMPLE_SPECS: Record<ChartKind, unknown> = {
  bar: {
    kind: "bar",
    title: "条形排名",
    unit: "篇",
    rows: [
      { label: "评审", value: 42 },
      { label: "写作", value: 18 },
    ],
  },
  waffle: {
    kind: "waffle",
    title: "占比方块",
    segments: [
      { label: "新客户", value: 62 },
      { label: "老客户", value: 38 },
    ],
  },
  timeline: {
    kind: "timeline",
    title: "时间线",
    items: [
      { date: "2026-03", title: "立项", detail: "第一版原型" },
      { date: "2026-06", title: "上线", detail: "公开内测" },
    ],
  },
  compare: {
    kind: "compare",
    title: "前后对比",
    left: { label: "旧方案", points: ["手动导出", "逐张压缩"] },
    right: { label: "新方案", points: ["一键生成", "自动压缩"] },
  },
  steps: {
    kind: "steps",
    title: "步骤流程",
    steps: [
      { title: "选模板", detail: "从模板库挑一套" },
      { title: "填数据", detail: "粘贴原始内容" },
    ],
  },
  kpi: {
    kind: "kpi",
    title: "关键数字",
    items: [
      { label: "本周阅读", value: "1.2 万", delta: "+18%" },
      { label: "完成率", value: "92%", delta: "+5%" },
    ],
  },
};

const CHART_KINDS = Object.keys(SAMPLE_SPECS) as ChartKind[];

/** 进程内缓存：同一进程内不重复渲染。 */
let cache: { samples: Record<string, string> } | null = null;

function buildSamples(): Record<string, string> {
  const samples: Record<string, string> = {};
  for (const kind of CHART_KINDS) {
    const { buffer } = renderChartPng(SAMPLE_SPECS[kind] as never, {
      width: SAMPLE_WIDTH,
      scale: SAMPLE_SCALE,
    });
    samples[kind] = `data:image/png;base64,${buffer.toString("base64")}`;
  }
  return samples;
}

export async function GET() {
  const blocked = await guard();
  if (blocked) return blocked;

  if (!cache) {
    cache = { samples: buildSamples() };
  }
  return NextResponse.json(cache);
}
