import { assertEqual, assertTrue, suite } from "./harness";
import {
  clampToEnvelope,
  DEFAULT_ARTICLE_LENGTH,
  describeLengthRange,
  parseLengthRange,
  parseManualLength,
  parseNumberText,
  parseOutlineRange,
  parseOutlineSectionBudgets,
  parseWritingLength,
  planSectionCount,
  renderLengthInstruction,
  resolveLengthTarget,
} from "../lib/length-target";

/**
 * 字数目标的解析。
 *
 * 这些用例守的是产品里最要紧的一件事：
 * 用户说「写 2000 字」，大纲说「总字数估算 2200–2500 字」，
 * 正文不能写成 1491 字然后说「大纲估的 2200」。
 */

suite("字数目标", ({ test }) => {
  test("阿拉伯数字与中文数字都能读", () => {
    assertEqual(parseNumberText("2000"), 2000);
    assertEqual(parseNumberText("两千"), 2000);
    assertEqual(parseNumberText("两千三百"), 2300);
    assertEqual(parseNumberText("一万二千"), 12000);
    assertEqual(parseNumberText("八百"), 800);
    assertEqual(parseNumberText("abc"), null);
  });

  test("从用户输入里认出「2000 字」", () => {
    const parsed = parseLengthRange("这篇写 2000 字左右，讲清楚那 800 行代码怎么省下来的。");
    assertTrue(parsed !== null, "应该认出 2000 字");
    assertEqual(parsed?.min, 2000);
    assertEqual(parsed?.max, 2000);
  });

  test("中文数字的「两千字」也能认出来", () => {
    const parsed = parseLengthRange("给我写两千字，别太短。");
    assertEqual(parsed?.min, 2000);
  });

  test("区间写法取上下限", () => {
    const parsed = parseLengthRange("全文 2200-2500 字。");
    assertEqual(parsed?.min, 2200);
    assertEqual(parsed?.max, 2500);
  });

  test("「不少于」只给下限，「不超过」只给上限", () => {
    const atLeast = parseLengthRange("不少于 2000 字。");
    assertEqual(atLeast?.min, 2000);
    assertEqual(atLeast?.max, 0);

    const atMost = parseLengthRange("不超过 1500 字。");
    assertEqual(atMost?.min, 0);
    assertEqual(atMost?.max, 1500);
  });

  test("材料里的其它数字不会误判成字数目标", () => {
    assertEqual(parseLengthRange("预算 3000 万元，团队 5 人，代码 800 行。"), null);
    assertEqual(parseLengthRange("这个字写得不好。"), null);
  });

  test("大纲里的总字数估算被认出来", () => {
    const outline = [
      "## 正文大纲",
      "> **第 1 段 · 钩子**",
      "> 篇幅：100–150 字",
      "> 总字数估算：2200–2500 字（按各段加总）",
    ].join("\n");
    const parsed = parseOutlineRange(outline);
    assertEqual(parsed?.min, 2200);
    assertEqual(parsed?.max, 2500);
  });

  test("大纲没有总账时，用各段篇幅相加", () => {
    const outline = [
      "> 篇幅：100–150 字",
      "> 篇幅：200–250 字",
      "> 篇幅：300 字",
    ].join("\n");
    const parsed = parseOutlineRange(outline);
    assertEqual(parsed?.min, 600);
    assertEqual(parsed?.max, 700);
  });

  test("逐节取出字数预算", () => {
    const outline = [
      "> **第 1 段 · 钩子**",
      "> 目的：让读者以为这是效率提升的爽文",
      "> 篇幅：250–300 字",
      "> 形式：叙述",
      "",
      "> **第 2 段 · 论据**",
      "> 篇幅：400 字",
    ].join("\n");
    const budgets = parseOutlineSectionBudgets(outline);
    assertEqual(budgets.length, 2);
    assertEqual(budgets[0].min, 250);
    assertEqual(budgets[0].max, 300);
    assertTrue(budgets[0].label.includes("钩子"), "要带上这一节的角色");
    assertEqual(budgets[1].min, 400);
    assertEqual(budgets[1].max, 400);
  });

  test("目标来源按 用户输入 → 大纲 → 选题 → 材料 的顺序取", () => {
    const target = resolveLengthTarget({
      userInput: "写 2000 字",
      outline: "总字数估算：3000–3500 字",
      angle: "适合篇幅：2500 字左右",
      brief: "打算写 4000 字",
    });
    assertEqual(target?.source, "input");
    assertEqual(target?.min, 2000);

    const fromOutline = resolveLengthTarget({
      userInput: "把第三段写详细一点",
      outline: "总字数估算：3000–3500 字",
      angle: "适合篇幅：2500 字左右",
      brief: "打算写 4000 字",
    });
    assertEqual(fromOutline?.source, "outline");
    assertEqual(fromOutline?.min, 3000);

    const fromAngle = resolveLengthTarget({
      userInput: "把第三段写详细一点",
      outline: "这里没有总账。",
      angle: "**适合篇幅**：2500 字左右，因为要铺开三个技术细节。",
      brief: "打算写 4000 字",
    });
    assertEqual(fromAngle?.source, "angle");
    assertEqual(fromAngle?.min, 2500);

    const fromBrief = resolveLengthTarget({
      userInput: "把第三段写详细一点",
      outline: "这里没有总账。",
      angle: "这里没有适合篇幅。",
      brief: "打算写 4000 字",
    });
    assertEqual(fromBrief?.source, "brief");
    assertEqual(fromBrief?.min, 4000);
  });

  test("什么都没有就返回空，不硬凑字数", () => {
    assertEqual(resolveLengthTarget({ userInput: "写一篇稿子" }), null);
  });

  test("输入里的素材字数不会被当成篇幅目标", () => {
    // 这是作者 2026-10-23 说的用法：输入常常就是两千多字的原话，
    // 里面「大概 2500 字」说的是素材有多长，不是稿子要写多长。
    assertEqual(parseWritingLength("这是我整理的素材，大概 2500 字，里面很多废话。"), null);
    assertEqual(parseWritingLength("材料如下：\n\n这是一段两千五百字的聊天记录。"), null);
    assertEqual(parseWritingLength("原文摘抄了 3000 字。"), null);

    // 但明确在谈写作篇幅的时候要认。
    assertEqual(parseWritingLength("写 1000 字左右，面向一线程序员。")?.min, 1000);
    assertEqual(parseWritingLength("全文 1200 字。")?.min, 1200);
    assertEqual(parseWritingLength("成稿 800 字，别注水。")?.min, 800);
    assertEqual(parseWritingLength("正文 800-1000 字。")?.max, 1000);
  });

  test("手填的字数目标说了算，比输入里的字更明确", () => {
    const target = resolveLengthTarget({
      manual: "900",
      userInput: "写 2000 字",
      outline: "总字数估算：3000–3500 字",
    });
    assertEqual(target?.source, "input");
    assertEqual(target?.min, 900);
    assertEqual(target?.max, 900);

    assertEqual(parseManualLength("1000")?.min, 1000);
    assertEqual(parseManualLength("800-1200")?.max, 1200);
    assertEqual(parseManualLength("  "), null);
    assertEqual(parseManualLength("随便写写"), null);
  });

  test("什么都不说就按默认篇幅走（公众号是短文）", () => {
    const target = resolveLengthTarget({
      userInput: "按这个思路写一篇公众号文章",
      defaultTarget: DEFAULT_ARTICLE_LENGTH,
    });
    assertEqual(target?.source, "default");
    assertEqual(target?.min, 700);
    assertEqual(target?.max, 1200);
  });

  test("默认篇幅在提示词里也要说得清楚", () => {
    // 字数指令只剩选题和大纲两道工序用。
    // 正文阶段没有——见 stage-engine 的「正文阶段不拿任何字数指令」。
    const text = renderLengthInstruction(DEFAULT_ARTICLE_LENGTH, "outline");
    assertTrue(text.includes("700–1200 字"), "要说出默认区间");
  });

  test("区间怎么说", () => {
    const target = { min: 2000, max: 2000, source: "input" as const, raw: "2000 字" };
    assertEqual(describeLengthRange(target), "2000 字");
  });

  test("模型自己定的篇幅推不出默认区间", () => {
    // 真模型实测（2026-10-23）：大纲阶段被要求落在 700–1200，
    // 交出来的总账是 1520–1920 字。提示词管不住，规矩得由代码守。
    const target = resolveLengthTarget({
      userInput: "按大纲写。",
      outline: "总字数估算：1520–1920 字",
      defaultTarget: DEFAULT_ARTICLE_LENGTH,
      envelope: DEFAULT_ARTICLE_LENGTH,
    });
    assertEqual(target?.min, 700);
    assertEqual(target?.max, 1200);
    assertEqual(target?.source, "default");
    assertTrue(target!.raw.includes("1520–1920"), "要留得住原来的原话");
  });

  test("区间相交时按交集收窄", () => {
    const target = resolveLengthTarget({
      userInput: "按大纲写。",
      outline: "总字数估算：900–1100 字",
      defaultTarget: DEFAULT_ARTICLE_LENGTH,
      envelope: DEFAULT_ARTICLE_LENGTH,
    });
    assertEqual(target?.min, 900);
    assertEqual(target?.max, 1100);
    assertEqual(target?.source, "outline");
  });

  test("用户自己说的数不受区间限制", () => {
    const target = resolveLengthTarget({
      userInput: "写 2500 字",
      outline: "总字数估算：1520–1920 字",
      defaultTarget: DEFAULT_ARTICLE_LENGTH,
      envelope: DEFAULT_ARTICLE_LENGTH,
    });
    assertEqual(target?.source, "input");
    assertEqual(target?.min, 2500);
  });

  test("整段比下限还短时照旧的，不硬凑", () => {
    const target = resolveLengthTarget({
      userInput: "按大纲写。",
      outline: "总字数估算：400–500 字",
      defaultTarget: DEFAULT_ARTICLE_LENGTH,
      envelope: DEFAULT_ARTICLE_LENGTH,
    });
    assertEqual(target?.min, 400);
    assertEqual(target?.max, 500);
    assertEqual(target?.source, "outline");
  });

  test("按目标算分段建议，给大纲阶段一个具体的分法", () => {
    const plan = planSectionCount(DEFAULT_ARTICLE_LENGTH);
    assertEqual(plan.sections, 4);
    assertEqual(plan.perMin, 175);
    assertEqual(plan.perMax, 300);

    const text = renderLengthInstruction(DEFAULT_ARTICLE_LENGTH, "outline");
    assertTrue(text.includes("大约分 4 段"), "要直接告诉模型分几段");
    assertTrue(text.includes("每段 175–300 字"), "要直接告诉模型每段多少字");
  });

  test("长文的分段建议也成比例", () => {
    const plan = planSectionCount({ min: 2000, max: 2500, source: "input", raw: "2000–2500 字" });
    assertEqual(plan.sections, 8);
    assertEqual(plan.perMin, 250);
    assertEqual(plan.perMax, 313);
  });

  test("写进提示词的说法分阶段", () => {
    const target = { min: 2200, max: 2500, source: "outline" as const, raw: "2200–2500 字" };
    const outlineText = renderLengthInstruction(target, "outline");
    assertTrue(outlineText.includes("2200–2500 字"), "大纲阶段要说出目标区间");
    assertTrue(outlineText.includes("各段"), "大纲阶段要说明各段相加要对上");

    const angleText = renderLengthInstruction(target, "angle");
    assertTrue(angleText.includes("适合篇幅"), "选题阶段要说明适合篇幅");
  });

  test("没有目标时也给得出话", () => {
    assertTrue(renderLengthInstruction(null, "angle").length > 0);
    assertTrue(renderLengthInstruction(null, "outline").length > 0);
  });
});
