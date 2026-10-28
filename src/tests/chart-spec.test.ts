import { assertEqual, assertTrue, suite } from "./harness";
import { chartSpecSchema } from "../lib/chart-spec";

const base = { title: "测试图" };

suite("图解 spec", ({ test }) => {
  test("六种图型都能通过校验", () => {
    const specs = [
      { kind: "bar", ...base, rows: [{ label: "甲", value: 3 }] },
      { kind: "waffle", ...base, segments: [{ label: "甲", value: 6 }, { label: "乙", value: 4 }] },
      { kind: "timeline", ...base, items: [{ date: "2026-01", title: "开始" }, { date: "2026-03", title: "上线" }] },
      { kind: "compare", ...base, left: { label: "旧", points: ["慢"] }, right: { label: "新", points: ["快"] } },
      { kind: "steps", ...base, steps: [{ title: "一" }, { title: "二" }] },
      { kind: "kpi", ...base, items: [{ label: "阅读", value: "1.2 万", delta: "+18%" }] },
    ];
    for (const spec of specs) {
      const parsed = chartSpecSchema.safeParse(spec);
      assertTrue(parsed.success, `${spec.kind} 应该通过`);
    }
  });

  test("缺数据 / 数据太少会被拒绝", () => {
    assertTrue(!chartSpecSchema.safeParse({ kind: "bar", ...base, rows: [] }).success);
    assertTrue(!chartSpecSchema.safeParse({ kind: "waffle", ...base, segments: [{ label: "甲", value: 1 }] }).success);
    assertTrue(!chartSpecSchema.safeParse({ kind: "compare", ...base, left: { label: "旧", points: [] }, right: { label: "新", points: ["快"] } }).success);
  });

  test("颜色必须是 #RRGGBB", () => {
    const bad = chartSpecSchema.safeParse({ kind: "bar", ...base, accent: "red", rows: [{ label: "甲", value: 1 }] });
    assertEqual(bad.success, false);
  });
});
