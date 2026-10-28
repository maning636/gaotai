import { z } from "zod";

/**
 * 图解 spec：模型/界面只产出「画什么」，渲染器负责「怎么画」。
 *
 * 这样做的好处：
 * - 图型固定，输出可复现，不会每次长得不一样；
 * - 数据、单位、来源都被 schema 管住，缺了直接报错，不编；
 * - 渲染器可以随时换实现（canvas / HTML → PNG），spec 不变。
 *
 * 六种图型的选型参考了 lieflat-charts 的数据形状分类与 show-me 的
 * 「最小视图」原则；实现为本项目自研（不复制其模板/代码）。
 */

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "颜色必须是 #RRGGBB");

const label = z.string().trim().min(1).max(40);
const value = z.string().trim().min(1).max(24);
const longText = z.string().trim().max(120);

export const chartSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bar"),
    title: z.string().trim().min(1).max(60),
    subtitle: z.string().trim().max(80).optional(),
    unit: z.string().trim().max(16).optional(),
    source: z.string().trim().max(80).optional(),
    accent: hexColor.optional(),
    rows: z
      .array(z.object({ label, value: z.number().finite() }))
      .min(1)
      .max(12),
  }),
  z.object({
    kind: z.literal("waffle"),
    title: z.string().trim().min(1).max(60),
    subtitle: z.string().trim().max(80).optional(),
    source: z.string().trim().max(80).optional(),
    accent: hexColor.optional(),
    segments: z
      .array(z.object({ label, value: z.number().finite().positive() }))
      .min(2)
      .max(6),
  }),
  z.object({
    kind: z.literal("timeline"),
    title: z.string().trim().min(1).max(60),
    subtitle: z.string().trim().max(80).optional(),
    source: z.string().trim().max(80).optional(),
    accent: hexColor.optional(),
    items: z
      .array(
        z.object({
          date: z.string().trim().min(1).max(20),
          title: z.string().trim().min(1).max(40),
          detail: longText.optional(),
        }),
      )
      .min(2)
      .max(8),
  }),
  z.object({
    kind: z.literal("compare"),
    title: z.string().trim().min(1).max(60),
    subtitle: z.string().trim().max(80).optional(),
    source: z.string().trim().max(80).optional(),
    accent: hexColor.optional(),
    left: z.object({
      label: z.string().trim().min(1).max(20),
      points: z.array(z.string().trim().min(1).max(60)).min(1).max(6),
    }),
    right: z.object({
      label: z.string().trim().min(1).max(20),
      points: z.array(z.string().trim().min(1).max(60)).min(1).max(6),
    }),
  }),
  z.object({
    kind: z.literal("steps"),
    title: z.string().trim().min(1).max(60),
    subtitle: z.string().trim().max(80).optional(),
    source: z.string().trim().max(80).optional(),
    accent: hexColor.optional(),
    steps: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(40),
          detail: longText.optional(),
        }),
      )
      .min(2)
      .max(8),
  }),
  z.object({
    kind: z.literal("kpi"),
    title: z.string().trim().min(1).max(60),
    subtitle: z.string().trim().max(80).optional(),
    source: z.string().trim().max(80).optional(),
    accent: hexColor.optional(),
    items: z
      .array(
        z.object({
          label,
          value,
          delta: z.string().trim().max(20).optional(),
        }),
      )
      .min(1)
      .max(6),
  }),
]);

export type ChartSpec = z.infer<typeof chartSpecSchema>;
export type ChartKind = ChartSpec["kind"];

export const CHART_KIND_LABELS: Record<ChartKind, string> = {
  bar: "条形排名",
  waffle: "占比方块",
  timeline: "时间线",
  compare: "前后对比",
  steps: "步骤流程",
  kpi: "关键数字",
};

/** 每种图型的数据格式提示（界面直接显示）。 */
export const CHART_KIND_HINTS: Record<ChartKind, string> = {
  bar: "每行一条：标签,数值\n例如：评审,42",
  waffle: "每行一段：标签,数值（按比例分配 100 格）\n例如：新客户,62",
  timeline: "每行一条：日期|标题|说明（说明可省略）\n例如：2026-03|立项|第一版原型",
  compare: "左栏要点一行一条，空行后 ---，再写右栏要点\n例如：\n旧方案\n手动导出\n---\n新方案\n一键生成",
  steps: "每行一步：标题|说明（说明可省略）\n例如：选模板|从模板库挑一套",
  kpi: "每行一项：标签,数值,变化（变化可省略）\n例如：本周阅读,1.2 万,+18%",
};
