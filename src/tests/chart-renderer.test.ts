import { assertTrue, suite } from "./harness";
import { buildChartPng, renderChartPng } from "../lib/chart-renderer";

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

suite("图解纯渲染函数 renderChartPng", ({ test }) => {
  for (const spec of specs) {
    test(`${spec.kind} 纯函数出 Buffer、PNG 头正确、宽高符合预期`, () => {
      const { buffer, width, height } = renderChartPng(spec as never);
      assertTrue(buffer.length > 1000, "PNG 不该是空的");
      assertTrue(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47, "PNG 签名要正确");
      // 默认参数保持既有行为：1000 CSS × 2 = 2000px 宽。
      assertTrue(width === 2000, "默认宽度应为 2000px");
      assertTrue(height > 400, "高度要能容纳内容");
    });
  }

  test("缩略图尺寸：900 CSS × 1x = 900px 宽", () => {
    const { buffer, width, height } = renderChartPng(specs[0] as never, { width: 900, scale: 1 });
    assertTrue(width === 900, "缩略图宽应为 900px");
    assertTrue(buffer[0] === 0x89 && buffer[1] === 0x50, "PNG 签名要正确");
    assertTrue(height > 200 && height < 900, "缩略图高度应合理");
  });

  test("缩略图比正文图小，且不落盘", () => {
    const full = renderChartPng(specs[0] as never);
    const thumb = renderChartPng(specs[0] as never, { width: 900, scale: 1 });
    assertTrue(thumb.width < full.width, "缩略图宽应小于正文图");
    assertTrue(thumb.buffer.length < full.buffer.length, "缩略图体积应更小");
  });
});
