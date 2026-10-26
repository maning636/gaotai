import { assertEqual, assertTrue, suite } from "./harness";
import { reportArticle } from "../lib/article-review";
import { checkOutlineCoverage } from "../lib/outline-coverage";
import type { LengthTarget, OutlineParagraph } from "../lib/length-target";

/**
 * 成稿体检（只读报告）与大纲要点覆盖。
 *
 * 这两条守的是新设计的两个要害：
 * 1. 体检只报告，不退回。差多少字、命中几条硬禁令，摆出来由人决定。
 * 2. 合格线是「大纲要点有没有落地」，不是「字数够不够」。
 */

/**
 * 一段干净的正文，用来当合格稿。
 *
 * 每句都不一样：新的重复规则会如实报出整句重复，
 * 拿同一句话复制几十遍当「干净稿」已经不成立了。
 *
 * 拼法上用三组短语轮着换，让任意两句共享不超过十个字——
 * 真人写的稿子里不会出现「连着两句只有开头两个字不同」。
 */
function cleanArticle(hanNeeded: number): string {
  const heads = [
    "那天夜里", "隔周早上", "开春以后", "入冬之前", "换季那阵", "调岗以后",
    "轮值那晚", "交接那天", "开夜之后", "发版前夕", "验收当场", "复盘会上",
  ];
  const middles = [
    "他没接话", "她也没接", "同事端来", "组长翻了", "新人愣了", "远程那端",
    "值班的推", "对口的摇头", "接手的把", "运维的叹", "设计的笑",
  ];
  const tails = [
    "把当天剩下的告警逐条核到天亮", "在工位上把那段日志又读了一遍", "把那封没回完的邮件删了重新写",
    "对着窗外的雨发了很久的呆", "把工牌摘下来放进了抽屉里", "起身去接了一杯凉掉的咖啡",
    "把这件事记在了便签的最下面", "把会议室的灯关到只剩一盏", "把当天的复盘记录发到了群里",
    "把那台旧机器搬到了墙角放着",
  ];
  const parts: string[] = [];
  let count = 0;
  let index = 0;
  while (count < hanNeeded) {
    const text =
      heads[index % heads.length] +
      middles[(index * 5) % middles.length] +
      tails[(index * 7) % tails.length];
    parts.push(text);
    count += (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    index += 1;
  }
  return parts.join("\n");
}

/** 一段命中硬禁令的正文。 */
function dirtyArticle(): string {
  return [
    "这不是效率问题，而是协作问题。",
    "关键是这样：那个 5 人的团队最后只剩 3 人。",
    "省下来的 800 行代码要有人接得住，这活儿才落得下。",
  ].join("\n");
}

const TARGET: LengthTarget = { min: 2000, max: 2000, source: "input", raw: "2000 字" };

suite("成稿体检是只读报告", ({ test }) => {
  test("命中硬禁令要如实报出来，并说明原因", () => {
    const report = reportArticle(dirtyArticle(), TARGET);
    assertTrue(report.failCount >= 2, `应该查到中文冒号和翻案句，实际 ${report.failCount} 条`);
    assertTrue(report.reasons.length > 0, "要说清楚查到了什么");
  });

  test("干净的稿子没有硬禁令", () => {
    const report = reportArticle(cleanArticle(2100), TARGET);
    assertEqual(report.failCount, 0, "干净稿不该有硬禁令");
    assertTrue(report.hanCount >= 1900, `字数应接近目标，实际 ${report.hanCount}`);
    assertEqual(report.missing, 0);
  });

  test("短多少字要报出来，但短不是错误", () => {
    const report = reportArticle(cleanArticle(600), TARGET);
    assertTrue(report.missing > 0, "要报出差多少字");
    assertTrue(report.reasons.some(item => item.includes("字")), "原因里要提到字数");
    // 报告里没有「不合格」这个概念：短只被记录，不被判刑。
    assertTrue(
      !report.reasons.some(item => item.includes("退回") || item.includes("不合格")),
      "体检不再退回，也不判不合格",
    );
  });

  test("没有字数目标时不算缺口", () => {
    const report = reportArticle(cleanArticle(300), null);
    assertEqual(report.missing, 0, "没有目标就不拿长度说事");
  });

  test("体检不修改正文，一个字都不动", () => {
    const content = dirtyArticle();
    const before = content;
    reportArticle(content, TARGET);
    assertEqual(content, before, "体检是只读的，不能改稿");
  });
});

/** 造一段大纲段落。 */
function paragraph(overrides: Partial<OutlineParagraph> & { label: string }): OutlineParagraph {
  return {
    purpose: "",
    advance: "",
    content: "",
    material: "",
    format: "",
    raw: "",
    min: 0,
    max: 0,
    ...overrides,
  };
}

suite("大纲要点覆盖", ({ test }) => {
  test("大纲里规划的关键词写到了就算落地", () => {
    const paragraphs = [
      paragraph({ label: "第 1 段", content: "800 行代码降到 300 行" }),
      paragraph({ label: "第 2 段", content: "团队从 5 人变成 3 人" }),
    ];
    const content = [
      "重构之后 800 行代码降到 300 行，评审的人少了一半。",
      "那个 5 人的团队最后只剩 3 人。",
    ].join("\n");
    const coverage = checkOutlineCoverage(paragraphs, content);
    assertEqual(coverage.total, 2, "大纲两段");
    assertEqual(coverage.covered, 2, "两段都写到了");
    assertEqual(coverage.missing.length, 0, "没有漏的");
  });

  test("整段没写到要说出来，并给出段标签", () => {
    const paragraphs = [
      paragraph({ label: "第 1 段", content: "800 行代码降到 300 行" }),
      paragraph({ label: "第 2 段", content: "Kubernetes 迁移到 1.29 版本" }),
    ];
    const content = "重构之后 800 行代码降到 300 行，评审的人少了一半。";
    const coverage = checkOutlineCoverage(paragraphs, content);
    assertEqual(coverage.total, 2);
    assertEqual(coverage.covered, 1, "只写到了第一段");
    assertTrue(coverage.missing.length > 0, "漏的段要报出来");
    assertTrue(
      coverage.missing.some(item => item.includes("第 2 段")),
      `要指出是哪一段漏了，实际：${coverage.missing.join("、")}`,
    );
  });

  test("抽不出关键词的段不瞎判", () => {
    // 没有可核对的锚点时，判了也是瞎判——宁可漏报不误报。
    const paragraphs = [paragraph({ label: "第 1 段", purpose: "引入问题" })];
    const coverage = checkOutlineCoverage(paragraphs, "随便写点什么都行。");
    assertEqual(coverage.covered, 1, "没有锚点就不判漏");
    assertEqual(coverage.missing.length, 0);
  });

  test("没有大纲时不算覆盖", () => {
    const coverage = checkOutlineCoverage([], "正文内容");
    assertEqual(coverage.total, 0);
    assertEqual(coverage.covered, 0);
  });

  test("推进字段也算关键词来源", () => {
    const paragraphs = [
      paragraph({ label: "第 1 段", advance: "把成本从 800 元降到 300 元", content: "" }),
    ];
    const coverage = checkOutlineCoverage(paragraphs, "这件事把成本从 800 元降到了 300 元。");
    assertEqual(coverage.covered, 1, "推进里提到的数字写到了就算落地");
  });

  test("纯中文措辞不拿来当判据，避免误报", () => {
    // 大纲写「评审流程没定」，正文写「评审那部分卡得更久」——
    // 这是同一件事，但机器认不出来。拿中文实词当判据会把写到了的段误判成漏写，
    // 误报比漏报更糟：用户会照着提示去改一篇其实没问题的稿子。
    const paragraphs = [paragraph({ label: "第 1 段", content: "评审流程没有定下来" })];
    const coverage = checkOutlineCoverage(paragraphs, "评审那部分卡得更久，工单堆了一周。");
    assertEqual(coverage.covered, 1, "认不出来就不判漏");
    assertEqual(coverage.missing.length, 0);
  });

  test("英文词和数字是能核对的锚点", () => {
    const paragraphs = [
      paragraph({ label: "第 1 段", content: "Kubernetes 迁到 1.29" }),
      paragraph({ label: "第 2 段", content: "TypeScript 升到 5.4" }),
    ];
    const missing = checkOutlineCoverage(paragraphs, "Kubernetes 已经迁到 1.29 版本。");
    assertEqual(missing.covered, 1, "第一段写到了");
    assertTrue(missing.missing.length > 0, "第二段没写到要报出来");
    assertTrue(
      missing.missing.some(item => item.includes("第 2 段")),
      `要指出是哪一段漏了，实际：${missing.missing.join("、")}`,
    );
  });

  test("「材料第 N 段」的段号不参与判定", () => {
    // 段号会变成一个孤零零的数字，正文里随便哪个数字都能命中，等于没判。
    const paragraphs = [paragraph({ label: "第 1 段", content: "（材料第 3 段）流程没定" })];
    const coverage = checkOutlineCoverage(paragraphs, "这件事跟流程没关系，第 3 季度再说。");
    assertEqual(coverage.covered, 1, "剥掉段号后没有锚点，不判漏");
    assertEqual(coverage.missing.length, 0);
  });

  test("百分比也是锚点", () => {
    const paragraphs = [paragraph({ label: "第 1 段", content: "线上问题涨了 30%" })];
    const hit = checkOutlineCoverage(paragraphs, "线上问题比原来多了 30%。");
    assertEqual(hit.covered, 1, "百分比写到了就算落地");
    const miss = checkOutlineCoverage(paragraphs, "线上问题确实多了一些。");
    assertEqual(miss.covered, 0, "百分比没出现就报漏");
  });
});
