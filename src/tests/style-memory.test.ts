import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import { analyzeEdits, MIN_EDITS_FOR_PROFILE } from "../lib/style-memory";
import type { EditRow } from "../lib/stages";

function edit(before: string, after: string, stage: "article" = "article"): EditRow {
  return {
    id: `edt_${Math.random().toString(36).slice(2)}`,
    project_id: "prj_test",
    stage,
    before_text: before,
    after_text: after,
    created_at: Date.now(),
  };
}

suite("风格分析", ({ test }) => {
  test("空编辑记录不会崩", () => {
    const analysis = analyzeEdits([]);
    assertEqual(analysis.editCount, 0);
    assertEqual(analysis.metrics.avgSentenceLength, 0);
    assertMatch(analysis.profile, /风格/);
  });

  test("短句比例被算出来", () => {
    const analysis = analyzeEdits([
      edit("AI 写的内容。", "短句。走。快。"),
      edit("x", "又是短句。继续。"),
    ]);
    assertTrue(analysis.metrics.shortSentenceRatio > 0.5, `短句占比应偏高，实际 ${analysis.metrics.shortSentenceRatio}`);
    assertTrue(analysis.metrics.avgSentenceLength < 8);
  });

  test("问句与感叹句的占比被单独统计", () => {
    const analysis = analyzeEdits([
      edit("a", "这是真的吗？"),
      edit("b", "太棒了！"),
      edit("c", "普通的一句话。"),
    ]);
    assertTrue(analysis.metrics.questionRatio > 0, "应有问句占比");
    assertTrue(analysis.metrics.exclamationRatio > 0, "应有感叹句占比");
  });

  test("作者新写的句子才计入风格样本", () => {
    // 改后完全重写：所有句子都是作者自己的
    const analysis = analyzeEdits([edit("这是模型原来的句子。", "这是作者自己重写的句子。")]);
    assertTrue(analysis.metrics.avgSentenceLength > 0);
    assertMatch(analysis.profile, /句子节奏|段落长度/);
  });

  test("画像写成可执行的指令而不是数字表", () => {
    const analysis = analyzeEdits([
      edit("一。", "我们先说清楚一件事。这件事很关键。"),
      edit("二。", "很多人忽略了这个前提。这不是细节。"),
    ]);
    assertMatch(analysis.profile, /平均每句/);
    assertMatch(analysis.profile, /平均每段/);
  });

  test("样本不足的门槛是 6 条", () => {
    assertEqual(MIN_EDITS_FOR_PROFILE, 6);
  });
});
