import { assertEqual, assertTrue, assertMatch, suite } from "./harness";
import {
  RATIO_PRESETS,
  RATIO_KEYS,
  DEFAULT_RATIO,
  pageSizeForRatio,
  createCardPagePlan,
  buildBlocksFromMarkdown,
  estimateBlockHeight,
  availableContentHeight,
  MAX_FIT_ROUNDS,
} from "../lib/card/render-engine";
import { buildCoverModel } from "../lib/card/cover-model";
import { getCardTheme, buildCardPageCss } from "../lib/card-themes";

suite("卡片渲染：比例预设", ({ test }) => {
  test("三种比例尺寸正确", () => {
    assertEqual(RATIO_PRESETS["3:4"], { w: 375, h: 500 });
    assertEqual(RATIO_PRESETS["3:5"], { w: 375, h: 625 });
    assertEqual(RATIO_PRESETS["9:16"], { w: 375, h: 667 });
  });

  test("RATIO_KEYS 顺序与默认比例", () => {
    assertEqual(RATIO_KEYS, ["3:4", "3:5", "9:16"]);
    assertEqual(DEFAULT_RATIO, "3:4");
  });

  test("pageSizeForRatio 返回正确尺寸，未知比例回落默认", () => {
    assertEqual(pageSizeForRatio("3:5"), { w: 375, h: 625 });
    assertEqual(pageSizeForRatio("bad"), { w: 375, h: 500 });
  });

  test("每套比例宽高比符合标注", () => {
    assertTrue(Math.abs(RATIO_PRESETS["3:4"].w / RATIO_PRESETS["3:4"].h - 3 / 4) < 0.01);
    assertTrue(Math.abs(RATIO_PRESETS["3:5"].w / RATIO_PRESETS["3:5"].h - 3 / 5) < 0.01);
    assertTrue(Math.abs(RATIO_PRESETS["9:16"].w / RATIO_PRESETS["9:16"].h - 9 / 16) < 0.01);
  });
});

suite("卡片渲染：分页逻辑", ({ test }) => {
  test("短文本单页", () => {
    const blocks = buildBlocksFromMarkdown("# 标题\n\n一段正文");
    const plan = createCardPagePlan({
      blocks,
      pageSize: { w: 375, h: 500 },
      contentHeight: 400,
      gap: 14,
    });
    assertEqual(plan.pages.length, 1);
    assertEqual(plan.pages[0].blocks.length, blocks.length);
    assertTrue(plan.complete);
  });

  test("长文本分多页", () => {
    // 20 段文本，每段估算足够大，必然溢出单页。
    const paragraphs = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 段正文内容`).join("\n\n");
    const blocks = buildBlocksFromMarkdown(paragraphs);
    const plan = createCardPagePlan({
      blocks,
      pageSize: { w: 375, h: 500 },
      contentHeight: 300,
      gap: 14,
    });
    assertTrue(plan.pages.length > 1, `应分成多页，实际 ${plan.pages.length}`);
  });

  test("空文档也至少一页", () => {
    const plan = createCardPagePlan({
      blocks: [],
      pageSize: { w: 375, h: 500 },
      contentHeight: 400,
      gap: 14,
    });
    assertEqual(plan.pages.length, 1);
    assertEqual(plan.pages[0].blocks.length, 0);
  });

  test("每页估算高度不超过可用高度（单块不超高时）", () => {
    const blocks = buildBlocksFromMarkdown(Array.from({ length: 30 }, (_, i) => `段落 ${i + 1}`).join("\n\n"));
    const plan = createCardPagePlan({
      blocks,
      pageSize: { w: 375, h: 500 },
      contentHeight: 320,
      gap: 14,
    });
    for (const page of plan.pages) {
      // 非最后页应装满；最后一页允许不满。
      assertTrue(page.estimatedHeight <= 320 + 14, `页 ${page.index} 估算高 ${page.estimatedHeight} 超限`);
    }
  });

  test("单块超高标记不完整", () => {
    const huge = { kind: "code" as const, content: "a\n".repeat(200), estimate: 3000, atomic: false };
    const plan = createCardPagePlan({
      blocks: [huge],
      pageSize: { w: 375, h: 500 },
      contentHeight: 300,
      gap: 14,
    });
    assertEqual(plan.complete, false);
  });

  test("buildBlocksFromMarkdown 识别标题/列表/引用/分隔线/图片", () => {
    const md = [
      "# 主标题",
      "",
      "一段正文",
      "",
      "- 列表项一",
      "- 列表项二",
      "",
      "> 引用",
      "",
      "---",
      "",
      "![配图](https://example.com/a.png)",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const blocks = buildBlocksFromMarkdown(md);
    const kinds = blocks.map(b => b.kind);
    assertTrue(kinds.includes("heading"), "应识别标题");
    assertTrue(kinds.includes("paragraph"), "应识别段落");
    assertTrue(kinds.includes("list"), "应识别列表");
    assertTrue(kinds.includes("blockquote"), "应识别引用");
    assertTrue(kinds.includes("thematicBreak"), "应识别分隔线");
    assertTrue(kinds.includes("image"), "应识别图片");
    assertTrue(kinds.includes("code"), "应识别代码块");
  });

  test("estimateBlockHeight 各类块都返回正数", () => {
    for (const kind of ["heading", "paragraph", "list", "blockquote", "code", "table", "thematicBreak", "image"] as const) {
      const h = estimateBlockHeight({ kind, content: "内容", estimate: 0 });
      assertTrue(h > 0, `${kind} 估算高度应为正，实际 ${h}`);
    }
  });
});

suite("卡片渲染：封面模型", ({ test }) => {
  test("buildCoverModel 派生标题/主题色/比例", () => {
    const theme = getCardTheme("dark-gold");
    assertTrue(theme !== undefined);
    if (!theme) return;
    const model = buildCoverModel({ title: "测试稿", topicName: "科技" }, theme, "3:5");
    assertEqual(model.title, "测试稿");
    assertEqual(model.subtitle, "科技");
    assertEqual(model.ratio, "3:5");
    assertEqual(model.size, { w: 375, h: 625 });
    assertEqual(model.accentColor, theme.tokens.accentColor);
    assertEqual(model.background, theme.tokens.background);
    assertEqual(model.coverStyle, theme.coverStyle);
  });

  test("空标题回落未命名", () => {
    const theme = getCardTheme("simple-white");
    assertTrue(theme !== undefined);
    if (!theme) return;
    const model = buildCoverModel({ title: "  " }, theme, "3:4");
    assertEqual(model.title, "未命名稿件");
  });

  test("不同封面风格产生不同装饰", () => {
    const magazine = buildCoverModel({ title: "A" }, getCardTheme("simple-white")!, "3:4");
    const neon = buildCoverModel({ title: "A" }, getCardTheme("neon-purple")!, "3:4");
    assertEqual(magazine.decorations[0].type, "dotRow");
    assertEqual(neon.decorations[0].type, "glow");
    assertTrue(magazine.decorations.length !== neon.decorations.length || magazine.decorations[0].type !== neon.decorations[0].type);
  });

  test("封面图透传", () => {
    const model = buildCoverModel({ title: "A" }, getCardTheme("simple-white")!, "3:4", "data:image/png;base64,xxx");
    assertEqual(model.coverImage, "data:image/png;base64,xxx");
  });
});

suite("卡片渲染：CSS 与可用高度", ({ test }) => {
  test("buildCardPageCss 输出包含主题色值", () => {
    const theme = getCardTheme("gradient-blue");
    assertTrue(theme !== undefined);
    if (!theme) return;
    const css = buildCardPageCss(theme);
    assertMatch(css, /\.icard/, "应以 .icard 为根");
    assertTrue(css.includes(theme.tokens.accentColor), "应包含强调色");
    assertTrue(css.includes(theme.tokens.cardBackground), "应包含内卡底色");
  });

  test("availableContentHeight 随比例增大", () => {
    const theme = getCardTheme("simple-white")!;
    const h34 = availableContentHeight(theme, { h: 500 });
    const h916 = availableContentHeight(theme, { h: 667 });
    assertTrue(h916 > h34);
  });

  test("MAX_FIT_ROUNDS 为 5", () => {
    assertEqual(MAX_FIT_ROUNDS, 5);
  });
});
