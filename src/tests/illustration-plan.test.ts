import { assertEqual, assertTrue, suite } from "./harness";
import {
  sanitizePlan,
  insertAfterParagraph,
  paragraphInsertOffset,
  maxChartsFor,
  articleCharCount,
  articleHasNumbers,
  splitParagraphs,
} from "../lib/illustration-plan";
import { insertMarkdownAt } from "../lib/editor-insert";
import { getPrompt } from "../lib/prompt-store";

// ---- 共用样例 ----

/** 含数字的正文（5 段，用于「合法计划通过」）。 */
const NUMERIC_ARTICLE = [
  "第一段：今年新增了 12 家客户。",
  "第二段：旧客户续约了 8 家，整体留存率达到 92%。",
  "第三段：我们把上线周期从 3 周压到了 1 周。",
  "第四段：写作环节从 6 小时降到 2 小时。",
  "第五段：这是收尾，不再提具体数字。",
].join("\n\n");

/** 不含数字的正文（5 段）。 */
const NO_NUMBER_ARTICLE = [
  "第一段：事情要从立项说起。",
  "第二段：先做需求，再做原型。",
  "第三段：原型之后进入开发。",
  "第四段：开发完了交给测试。",
  "第五段：最后才轮到上线。",
].join("\n\n");

const barItem = (overrides: Record<string, unknown> = {}) => ({
  kind: "bar",
  title: "客户构成",
  afterParagraph: 2,
  rationale: "把三组数字并排比，省去读者自己加总。",
  data: { kind: "bar", title: "客户构成", rows: [{ label: "新增", value: 12 }, { label: "续约", value: 8 }] },
  ...overrides,
});

suite("配图计划清洗 sanitizePlan", ({ test }) => {
  test("合法计划通过：条目保留、无警告", () => {
    const raw = { plan: [barItem()] };
    const { plan, warnings } = sanitizePlan(raw, NUMERIC_ARTICLE);
    assertEqual(plan.length, 1);
    assertEqual(plan[0].kind, "bar");
    assertEqual(plan[0].afterParagraph, 2);
    assertEqual(plan[0].rationale, barItem().rationale);
    assertTrue(warnings.length === 0, `不应有警告，实际：${warnings.join(" | ")}`);
  });

  test("无数字正文：bar / waffle / kpi 被丢弃并产生 warning", () => {
    const raw = {
      plan: [
        barItem({ title: "条形" }),
        { ...barItem({ title: "方块" }), kind: "waffle", data: { kind: "waffle", title: "方块", segments: [{ label: "甲", value: 60 }, { label: "乙", value: 40 }] } },
        { ...barItem({ title: "关键" }), kind: "kpi", data: { kind: "kpi", title: "关键", items: [{ label: "阅读", value: "1.2 万" }] } },
        { ...barItem({ title: "时间线" }), kind: "timeline", data: { kind: "timeline", title: "时间线", items: [{ date: "2026-03", title: "立项" }, { date: "2026-06", title: "上线" }] } },
      ],
    };
    const { plan, warnings } = sanitizePlan(raw, NO_NUMBER_ARTICLE);
    const kinds = plan.map(item => item.kind);
    assertTrue(!kinds.includes("bar"), "无数字时不该保留 bar");
    assertTrue(!kinds.includes("waffle"), "无数字时不该保留 waffle");
    assertTrue(!kinds.includes("kpi"), "无数字时不该保留 kpi");
    assertTrue(kinds.includes("timeline"), "结构类图应保留");
    assertTrue(warnings.some(w => w.includes("bar")), "bar 的丢弃原因应写进 warnings");
    assertTrue(warnings.some(w => w.includes("kpi")), "kpi 的丢弃原因应写进 warnings");
  });

  test("data 与类型不匹配的条目被丢弃并产生 warning", () => {
    const raw = { plan: [barItem({ data: { kind: "steps", title: "步骤", steps: [{ title: "一" }, { title: "二" }] } })] };
    const { plan, warnings } = sanitizePlan(raw, NUMERIC_ARTICLE);
    assertEqual(plan.length, 0, "类型不匹配的条目应整条丢弃");
    assertTrue(warnings.some(w => w.includes("不一致")), "应写不一致原因");
  });

  test("data 校验失败的条目被丢弃并产生 warning", () => {
    const raw = { plan: [barItem({ data: { kind: "bar", title: "客户构成", rows: [] } })] };
    const { plan, warnings } = sanitizePlan(raw, NUMERIC_ARTICLE);
    assertEqual(plan.length, 0, "data 不合格应整条丢弃");
    assertTrue(warnings.some(w => w.includes("校验失败")), "应写校验失败原因");
  });

  test("afterParagraph 越界被夹紧并产生 warning", () => {
    const raw = { plan: [barItem({ afterParagraph: 99 })] };
    const { plan, warnings } = sanitizePlan(raw, NUMERIC_ARTICLE);
    assertEqual(plan.length, 1, "越界段落应被夹回合法范围而不是丢弃");
    assertEqual(plan[0].afterParagraph, splitParagraphs(NUMERIC_ARTICLE).length, "应夹到最后一个段落");
    assertTrue(warnings.some(w => w.includes("越界")), "应写越界原因");
  });

  test("超过张数上限被截断并产生 warning", () => {
    // >3000 字才允许 3 张；构造一个短正文让上限是 1 张。
    const shortArticle = "第一段有 12 家客户。\n\n第二段续约了 8 家。";
    const raw = {
      plan: [
        barItem({ title: "图一", afterParagraph: 1 }),
        barItem({ title: "图二", afterParagraph: 2 }),
      ],
    };
    const { plan, warnings } = sanitizePlan(raw, shortArticle);
    assertEqual(plan.length, maxChartsFor(articleCharCount(shortArticle)), "超出上限应截断");
    assertTrue(warnings.some(w => w.includes("超出") || w.includes("截断")), "应写截断原因");
  });

  test("同一位置最多一张", () => {
    const raw = {
      plan: [
        barItem({ title: "图一", afterParagraph: 2 }),
        barItem({ title: "图二", afterParagraph: 2 }),
      ],
    };
    const { plan, warnings } = sanitizePlan(raw, NUMERIC_ARTICLE);
    assertEqual(plan.length, 1, "同一位置只能留一张");
    assertTrue(warnings.some(w => w.includes("同一位置")), "应写撞位原因");
  });

  test("模型返回不是合法对象时整份丢弃并给 warning", () => {
    const { plan, warnings } = sanitizePlan({ plan: "不是数组" }, NUMERIC_ARTICLE);
    assertEqual(plan.length, 0);
    assertTrue(warnings.length > 0, "格式不对应给 warning");
  });
});

suite("配图计划段落定位", ({ test }) => {
  test("afterParagraph=2 插到第 2 段之后", () => {
    const article = ["第一段内容。", "第二段内容。", "第三段内容。"].join("\n\n");
    const { content, ok } = insertAfterParagraph(article, 2, "![图](x.png)");
    assertTrue(ok, "段落存在时应插入成功");
    const parts = content.split("\n\n").filter(Boolean);
    assertEqual(parts[0], "第一段内容。");
    assertEqual(parts[1], "第二段内容。");
    assertTrue(parts[2].includes("![图](x.png)"), "图应落在第 2 段之后、第 3 段之前");
    assertEqual(parts[3], "第三段内容。");
  });

  test("越界段落退到末尾并计入失败（带原因）", () => {
    const article = ["第一段内容。", "第二段内容。"].join("\n\n");
    const { content, ok, reason } = insertAfterParagraph(article, 99, "![图](x.png)");
    assertTrue(!ok, "越界应标记失败");
    assertTrue(Boolean(reason), "应给出失败原因");
    assertTrue(content.trim().endsWith("![图](x.png)"), "应退到末尾插入");
  });

  test("空正文也退到末尾", () => {
    const { content, ok, reason } = insertAfterParagraph("", 1, "![图](x.png)");
    assertTrue(!ok);
    assertTrue(Boolean(reason));
    assertTrue(content.includes("![图](x.png)"));
  });

  test("paragraphInsertOffset 与 insertAfterParagraph 一致", () => {
    const article = ["第一段内容。", "第二段内容。", "第三段内容。"].join("\n\n");
    const offset = paragraphInsertOffset(article, 2);
    const { content } = insertAfterParagraph(article, 2, "![图](x.png)");
    // 用同样偏移插一次，结果应与 insertAfterParagraph 相同。
    const { content: viaOffset } = insertMarkdownAt(article, offset, "![图](x.png)");
    assertEqual(viaOffset, content);
  });

  test("splitParagraphs 按空行分段并去空段", () => {
    const parts = splitParagraphs("甲。\n\n乙。\n\n\n丙。\n\n");
    assertEqual(parts, ["甲。", "乙。", "丙。"]);
  });

  test("张数上限与字数检测", () => {
    assertEqual(maxChartsFor(1000), 1);
    assertEqual(maxChartsFor(1500), 1);
    assertEqual(maxChartsFor(2000), 2);
    assertEqual(maxChartsFor(3000), 2);
    assertEqual(maxChartsFor(4000), 3);
    assertTrue(articleHasNumbers("有 12 家"));
    assertTrue(!articleHasNumbers("没有数字"));
  });
});

suite("配图计划提示词规则", ({ test }) => {
  test("illustration-plan 提示词文件存在且包含 6 条规则关键词", () => {
    const prompt = getPrompt("illustration-plan");
    assertTrue(prompt.length > 200, "提示词内容过短");
    // 规则 1：只用已出现的数字；无数字不用 bar/waffle/kpi；编造数字是严重错误。
    assertTrue(prompt.includes("已经出现"), "规则1：只从文章已出现的数字取数据");
    assertTrue(prompt.includes("编造数字是严重错误"), "规则1：编造数字是严重错误");
    // 规则 2：没有数字时用结构类图。
    assertTrue(prompt.includes("没有数字"), "规则2：无数字时用结构类图");
    assertTrue(prompt.includes("timeline"), "规则2：提到 timeline");
    // 规则 3：按篇幅给张数，宁少勿多。
    assertTrue(prompt.includes("宁少勿多"), "规则3：宁少勿多");
    assertTrue(prompt.includes("1500"), "规则3：提到字数档位");
    // 规则 4：位置落在对应段落之后，同一位置最多一张。
    assertTrue(prompt.includes("afterParagraph"), "规则4：提到 afterParagraph");
    assertTrue(prompt.includes("同一位置最多一张"), "规则4：同一位置最多一张");
    // 规则 5：每张都要 rationale，不许写空话。
    assertTrue(prompt.includes("rationale"), "规则5：提到 rationale");
    assertTrue(prompt.includes("省了什么力气"), "规则5：不许写「展示数据」这类空话");
    // 规则 6：data 严格符合类型格式。
    assertTrue(prompt.includes("data"), "规则6：提到 data");
    assertTrue(prompt.includes("kind"), "规则6：data.kind 与条目一致");
  });
});
