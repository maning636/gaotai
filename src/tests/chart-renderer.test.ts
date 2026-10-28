import { assertTrue, suite } from "./harness";
import { buildChartPng } from "../lib/chart-renderer";

const specs = [
  { kind: "bar", title: "条形排名", rows: [{ label: "评审", value: 42 }, { label: "写作", value: 18 }] },
  { kind: "waffle", title: "占比方块", segments: [{ label: "新客户", value: 62 }, { label: "老客户", value: 38 }] },
  { kind: "timeline", title: "时间线", items: [{ date: "2026-03", title: "立项" }, { date: "2026-06", title: "上线" }] },
  { kind: "compare", title: "前后对比", left: { label: "旧", points: ["手动导出"] }, right: { label: "新", points: ["一键生成"] } },
  { kind: "steps", title: "步骤", steps: [{ title: "选模板" }, { title: "填数据" }] },
  { kind: "kpi", title: "关键数字", items: [{ label: "阅读", value: "1.2 万", delta: "+18%" }] },
] as const;

suite("图解渲染", ({ test }) => {
  for (const spec of specs) {
    test(`${spec.kind} 能渲染成 2000px 宽的 PNG`, async () => {
      const { buffer, width, height } = await buildChartPng(spec as never);
      assertTrue(buffer.length > 1000, "PNG 不该是空的");
      assertTrue(buffer[0] === 0x89 && buffer[1] === 0x50, "PNG 签名要正确");
      assertTrue(width === 2000, "宽度应为 2000px");
      assertTrue(height > 400, "高度要能容纳内容");
      assertTrue(buffer.length < 1_500_000, "单张图要小于 1.5MB");
    });
  }
});
