import { assertEqual, assertTrue, suite } from "./harness";
import {
  countHan,
  joinArticleSections,
  planSectionExpansion,
  splitArticleSections,
} from "../lib/article-sections";
import {
  fitParagraphsToTarget,
  parseLabelLength,
  parseOutlineParagraphs,
  parseOutlineSectionBudgets,
} from "../lib/length-target";

/**
 * 正文的小节结构。
 *
 * 这一层要守的是「切得准、拼得回、对得上号」：
 * 切的时候不动一个字，拼的时候也不动一个字——
 * 按节补写要是动了别的地方，接缝一眼就能看出来。
 */

const ARTICLE = [
  "写代码的时间省下来了，改代码的活儿一点没少，最后还在他桌上。",
  "",
  "## 代码行数少了一半多",
  "",
  "2023 年一个中等功能模块约 800 行代码，现在约 300 行。",
  "",
  "## 写、改、审，三个环节的方向不一致",
  "",
  "写变快了，改没变少，审的资源在减少。",
].join("\n");

suite("正文小节结构", ({ test }) => {
  test("开头那一段也算一节", () => {
    const sections = splitArticleSections(ARTICLE);
    assertEqual(sections.length, 3, "开头一段加两个小节");
    assertEqual(sections[0].heading, "", "开头那段没有小标题");
    assertTrue(sections[0].hanCount > 0, "开头那段要有字数");
    assertEqual(sections[1].heading, "代码行数少了一半多");
    assertEqual(sections[2].heading, "写、改、审，三个环节的方向不一致");
  });

  test("小节正文里不含标题行", () => {
    const sections = splitArticleSections(ARTICLE);
    assertTrue(!sections[1].body.includes("代码行数少了一半多"), "标题不该混进正文");
    assertTrue(sections[1].body.includes("800 行"), "正文要留住");
  });

  test("切开后拼回去一个字都不差", () => {
    const sections = splitArticleSections(ARTICLE);
    const joined = joinArticleSections(sections);
    assertEqual(joined, ARTICLE.trim(), "原样拼回去");
  });

  test("三级小标题也算一节（模型就是这么写的）", () => {
    // 真模型实测（2026-10-22）：提示词写「小节 `##`，子小节 `###`」，
    // 模型把标题写成 `##`、把正文各段写成 `###`。
    // 只认 `##` 的话，八段正文会被压成一节，逐节补写整个对不上号。
    const sections = splitArticleSections("## 甲\n\n正文\n\n### 乙\n\n更细的正文");
    assertEqual(sections.length, 2, "### 也是一节");
    assertEqual(sections[1].heading, "乙");
    assertTrue(sections[1].body.includes("更细的正文"));
  });

  test("每一节都记着自己所在的行号", () => {
    const sections = splitArticleSections(ARTICLE);
    assertEqual(sections[0].startLine, 1, "开头那节从第 1 行开始");
    assertTrue(sections[1].startLine > sections[0].endLine, "第二节在第一节后面");
    assertEqual(sections[2].endLine, ARTICLE.split(/\r?\n/).length, "最后一节到文末");
  });

  test("数汉字只数汉字", () => {
    assertEqual(countHan("abc 123 中文"), 2);
  });
});

suite("按节补写的对号与缺口", ({ test }) => {
  const budgets = [
    { min: 250, max: 300 },
    { min: 300, max: 350 },
    { min: 400, max: 450 },
  ];

  test("小节数和大纲段数一样多才对得上", () => {
    const sections = splitArticleSections("## 甲\n\n短\n\n## 乙\n\n也短\n\n## 丙\n\n还是短");
    const plan = planSectionExpansion(sections, budgets);
    assertEqual(plan.aligned, true, "三个小节对三段账");
    assertEqual(plan.deficits.length, 3, "三节都短，都要补");
  });

  test("多一个小节就地对不上", () => {
    const sections = splitArticleSections("## 甲\n\n短\n\n## 乙\n\n也短\n\n## 丙\n\n还是短\n\n## 丁\n\n多出来的");
    const plan = planSectionExpansion(sections, budgets);
    assertEqual(plan.aligned, false, "小节数对不上就不能按节补");
    assertEqual(plan.deficits.length, 0, "对不上就不给补写计划");
  });

  test("够长的节不安排补写", () => {
    const long = "他坐在工位上把最后一行日志看完，合上笔记本，跟同事说了句先吃饭。".repeat(8);
    const sections = splitArticleSections(`## 甲\n\n${long}\n\n## 乙\n\n短\n\n## 丙\n\n也短`);
    const plan = planSectionExpansion(sections, budgets);
    assertEqual(plan.aligned, true);
    assertEqual(plan.deficits.length, 2, "够长的那节不补");
    assertEqual(plan.deficits[0].index, 1, "补的是第二节");
  });

  test("差得不多就不单独补", () => {
    const almost = "他坐在工位上把最后一行日志看完，合上笔记本，跟同事说了句先吃饭。".repeat(8);
    const sections = splitArticleSections(`## 甲\n\n${almost}\n\n## 乙\n\n短\n\n## 丙\n\n也短`);
    const tight = [
      { min: 1, max: 10 },
      { min: 300, max: 350 },
      { min: 400, max: 450 },
    ];
    const plan = planSectionExpansion(sections, tight);
    assertEqual(plan.deficits.length, 2, "只差几个字的不补");
  });
});

suite("大纲段落解析", ({ test }) => {
  const OUTLINE = [
    "## 正文大纲",
    "",
    "> **第 1 段 · 钩子+立论**",
    "> 目的：让读者三行内接受主张",
    "> 内容：用老工程师的那句话直接切入",
    "> 素材：作者判断第 5 条",
    "> 篇幅：250–300 字",
    "> 形式：叙述+引用",
    "",
    "> **第 2 段 · 论据**",
    "> 目的：证明写快了这件事",
    "> 内容：800 行变 300 行",
    "> 素材：硬事实第 4 条",
    "> 篇幅：400–450 字",
    "> 形式：数据+对照",
    "",
    "> 总字数估算：650–750 字（第 1–2 段加总）",
  ].join("\n");

  test("逐段取出施工说明", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE);
    assertEqual(paragraphs.length, 2, "两段");
    assertTrue(paragraphs[0].label.includes("第 1 段"), "段标签要取到");
    assertEqual(paragraphs[0].purpose, "让读者三行内接受主张");
    assertEqual(paragraphs[0].content, "用老工程师的那句话直接切入");
    assertEqual(paragraphs[0].material, "作者判断第 5 条");
    assertEqual(paragraphs[0].format, "叙述+引用");
    assertEqual(paragraphs[1].min, 400);
    assertEqual(paragraphs[1].max, 450);
  });

  test("没有大纲就返回空", () => {
    assertEqual(parseOutlineParagraphs("").length, 0);
    assertEqual(parseOutlineParagraphs("没有段落的大纲").length, 0);
  });
});

/**
 * 真模型实测出来的第三种大纲写法：段落标题用 markdown 标题。
 *
 * 提示词里写的是「> **第 N 段**」，模型交回来的是「## 第 N 段 · 钩子」，
 * 行首的 `##` 没被剥掉 → 标题正则不匹配 → 解析出 0 段 →
 * 分节退路失效 → 正文阶段空等 6 分钟才报错（2026-10-23）。
 *
 * 改一次提示词就会换一个写法，所以解析器必须比提示词更宽容。
 */
suite("大纲段落解析：markdown 标题形状", ({ test }) => {
  const OUTLINE = [
    "全文主张：写快了不等于写好了，评审方式的调整必须一起做。",
    "",
    "## 第 1 段 · 钩子兼立论",
    "目的：三行内亮出主张",
    "内容：老工程师那句「行数少就是少维护」",
    "素材：材料第 3 段的对比数据",
    "篇幅：266 字",
    "形式：引用加叙述",
    "",
    "## 第 2 段 · 论据",
    "目的：证明写快了这件事",
    "内容：800 行降到 300 行的真实案例",
    "素材：硬事实第 4 条",
    "篇幅：266 字",
    "形式：数据加对照",
    "",
    "总字数估算：790–810 字（3 段各 266 字）",
  ].join("\n");

  test("标题行首的 markdown 标记被剥掉，段落照样拆得出来", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE);
    assertEqual(paragraphs.length, 2, "两段");
    assertTrue(paragraphs[0].label.includes("第 1 段"), "段标签要取到");
    assertTrue(paragraphs[0].label.includes("钩子兼立论"), "角色也要留着");
    assertEqual(paragraphs[0].purpose, "三行内亮出主张");
    assertEqual(paragraphs[0].content, "老工程师那句「行数少就是少维护」");
    assertEqual(paragraphs[0].material, "材料第 3 段的对比数据");
    assertEqual(paragraphs[0].format, "引用加叙述");
    assertEqual(paragraphs[0].max, 266, "「篇幅：266 字」要认出来");
  });

  test("素材里带「第 3 段」的行不会被误切成新的一段", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE);
    assertEqual(paragraphs.length, 2, "不能被切成三段或更多");
  });

  test("三种标题写法解析出来的东西一样", () => {
    const quoted = [
      "> **第 1 段 · 钩子兼立论**",
      "> 目的：三行内亮出主张",
      "> 篇幅：266 字",
    ].join("\n");
    const hashed = ["## 第 1 段 · 钩子兼立论", "目的：三行内亮出主张", "篇幅：266 字"].join("\n");
    const bold = ["**第 1 段 · 钩子兼立论**", "目的：三行内亮出主张", "篇幅：266 字"].join("\n");
    for (const shape of [quoted, hashed, bold]) {
      const paragraphs = parseOutlineParagraphs(shape);
      assertEqual(paragraphs.length, 1, "每种写法都要解析出一段");
      assertEqual(paragraphs[0].purpose, "三行内亮出主张");
      assertEqual(paragraphs[0].max, 266);
    }
  });
});

/**
 * 真模型实测出来的另一种大纲写法。
 *
 * 提示词要求「篇幅：250–300 字」单独一行，模型没照做——
 * 它把字数塞进了段落标题：「**第 4 段·论据（480-520 字）**」。
 * 只认「篇幅：」的行，等于把整份字数账丢掉：
 * 逐节预算、结构锁、按节补写全都无从谈起。
 */
const OUTLINE_INLINE_LENGTH = [
  "## 中间几段分别讲什么",
  "",
  "**第 1 段·钩子（200-240 字）**",
  "目的：用具体数字抓住读者。",
  "内容：800 行→300 行的对比。",
  "素材：材料第 3 段的对比数据。",
  "形式：数据 + 反问。",
  "",
  "**第 2 段·论据（480-520 字）**",
  "目的：拆解省下的时间去了哪里。",
  "内容：调试、验收、返工三个去向。",
  "素材：材料第 3 段。",
  "形式：列表 + 叙述。",
  "",
  "> 总字数估算：680–760 字（第 1–2 段加总）",
].join("\n");

suite("大纲字数账的两种写法", ({ test }) => {
  test("字数塞在标题里也要认出来", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE_INLINE_LENGTH);
    assertEqual(paragraphs.length, 2, "两段");
    assertEqual(paragraphs[0].min, 200);
    assertEqual(paragraphs[0].max, 240);
    assertEqual(paragraphs[1].min, 480);
    assertEqual(paragraphs[1].max, 520);
    assertTrue(paragraphs[0].purpose.includes("具体数字"), "施工说明照常取到");
  });

  test("逐节预算也能从标题里取出来", () => {
    const budgets = parseOutlineSectionBudgets(OUTLINE_INLINE_LENGTH);
    assertEqual(budgets.length, 2, "两节预算");
    assertEqual(budgets[1].min, 480);
    assertEqual(budgets[1].max, 520);
  });

  test("标题里的字数认不准时，宁可没有也不要瞎猜", () => {
    assertEqual(parseLabelLength("第 3 段·背景"), null, "没有字数就没有");
    assertEqual(parseLabelLength("第 3 段·背景（需补）"), null, "括号里不是字数就不认");
    assertEqual(parseLabelLength("第 3 段·背景（20-30 字）"), null, "小于 100 字不算字数账");
  });
});

/**
 * 散文式大纲。
 *
 * 真模型有时不按模板的结构式写，而是写成三个小节：
 * 「开头怎么进」「中间几段分别讲什么」「结尾落点在哪里」。
 *
 * 这种大纲如果只按结构式解析，会出两个问题：
 * 1. 开头和结尾两节**整段消失**——正文就没有钩子、没有落点了；
 * 2. 中间几段被解析成「标签是整句话、目的为空」的假段落，
 *    分节写作的提示词里就出现「这一段的目的：」后面什么都没有，
 *    模型陷进逐条猜的思考，8192 额度全被思考吃光，正文一个字都没有
 *    （真模型实测：finish_reason=length，reasoning_tokens=8192，content 空）。
 */
const OUTLINE_PROSE = [
  "**标题候选**",
  "",
  "1. 省的不是工作量，是打字的时间",
  "2. AI 编程助手到底省了什么",
  "",
  "**开头怎么进**",
  "",
  "用一位写了 12 年代码的同事的原话直接开场，制造认知冲突。",
  "",
  "**中间几段分别讲什么**",
  "",
  "第 2 段讲数据。14 人团队 6 人用了 AI，4 人说省了时间，2 人说后来又补回去。",
  "",
  "第 3 段讲反方。先接住「行数少就是少维护」这个反驳，再转到代码规范问题。",
  "",
  "**结尾落点在哪里**",
  "",
  "落点在边界条件和下一步动作。先回答「什么时候 AI 真的能省出工作量」。",
  "",
  "**需要哪些素材或例子支撑**",
  "",
  "已有素材：12 年同事原话、6 人使用调查数据、800 行 vs 300 行对比。",
].join("\n");

suite("散文式大纲也要拆得出段落", ({ test }) => {
  test("开头、中间、结尾一个都不丢", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE_PROSE);
    assertEqual(paragraphs.length, 4, "开头两段加结尾，一共四段");
    assertTrue(paragraphs[0].label.includes("开头"), "第一段是开头");
    assertTrue(paragraphs[3].label.includes("结尾"), "最后一段是结尾");
    assertTrue(paragraphs[1].label.includes("第 2 段"), "中间段保留原来的编号");
    assertTrue(paragraphs[1].label.includes("讲数据"), "段名取第一个句号前那几个字");
  });

  test("每一段都有能执行的目的，不给模型一个空任务", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE_PROSE);
    for (const item of paragraphs) {
      assertTrue(item.purpose.length > 0, `${item.label} 要有目的`);
    }
    assertTrue(
      paragraphs[1].purpose.includes("14 人团队"),
      "中间段的说明文字就是这一段要写什么",
    );
  });

  test("标题小节和素材小节不算段落", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE_PROSE);
    const labels = paragraphs.map(item => item.label).join("|");
    assertTrue(!labels.includes("标题候选"), "标题候选不是段落");
    assertTrue(!labels.includes("素材"), "素材清单不是段落");
  });

  test("结构式大纲还是走结构式那一套", () => {
    const structured = [
      "> **第 1 段 · 钩子**",
      "> 目的：让读者三行内接受主张",
      "> 内容：用老工程师的那句话直接切入",
      "> 篇幅：250–300 字",
      "> **第 2 段 · 论据**",
      "> 目的：证明写快了这件事",
      "> 篇幅：400–450 字",
    ].join("\n");
    const paragraphs = parseOutlineParagraphs(structured);
    assertEqual(paragraphs.length, 2, "两段");
    assertEqual(paragraphs[0].purpose, "让读者三行内接受主张");
    assertEqual(paragraphs[1].max, 450, "字数账照常取到");
  });
});

/**
 * 各段的字数账要跟全文目标对得上。
 *
 * 大纲常常是在「还没定字数」的时候写的：模型自己给每段安排 400–500 字，
 * 八段加起来三千多，而用户在正文阶段要的是 2000 字。
 * 这时候提示词里会同时出现两个矛盾的数字，模型写出来的长度就随缘。
 *
 * 所以差得多就按全文目标等比缩放，差得不多就照用。
 */
suite("各段字数账与全文目标对齐", ({ test }) => {
  const paragraphs = parseOutlineParagraphs(OUTLINE_INLINE_LENGTH);

  test("差得不多时照用大纲自己的账", () => {
    const target = { min: 2000, max: 2000, source: "input" as const, raw: "2000 字" };
    // 200 + 480 = 680，对 2000 来说差得太远——换一组接近的账来试。
    const near = paragraphs.map(item => ({ ...item, min: 1000, max: 1100 }));
    const fitted = fitParagraphsToTarget(near, target);
    assertEqual(fitted[0].min, 1000, "差得不多就不动用户的账");
    assertEqual(fitted[0].max, 1100);
  });

  test("差得多时按全文目标等比缩放", () => {
    const target = { min: 2000, max: 2000, source: "input" as const, raw: "2000 字" };
    // 八段各 440–500，加总 3520；用户要 2000，缩放后每段约 250。
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...paragraphs[0],
      label: `第 ${index + 1} 段·第${index + 1}节`,
      min: 440,
      max: 500,
    }));
    const fitted = fitParagraphsToTarget(many, target);
    const total = fitted.reduce((sum, item) => sum + item.min, 0);
    assertTrue(Math.abs(total - 2000) <= 40, `缩放后加总要落回目标附近，实际 ${total}`);
    assertTrue(fitted[0].min < 440, "每一段都要按比例缩下去");
    assertTrue(fitted[0].max > fitted[0].min, "上下限的关系不变");
  });

  test("没有目标时不缩放", () => {
    const fitted = fitParagraphsToTarget(paragraphs, null);
    assertEqual(fitted[0].min, paragraphs[0].min, "没目标就照大纲自己的账");
  });
});
