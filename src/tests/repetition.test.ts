import { assertEqual, assertTrue, suite } from "./harness";
import { containment, dedupeRepeatedSentences, findDegenerateRepetition, findRepetitions, similarity } from "../lib/repetition";
import { checkProse } from "../lib/prose-check";

/**
 * 重复检测与去重。
 *
 * 这条能力是补出来的：真模型成稿里「省下的时间流向了别的地方」出现四次，
 * 「老工程师那句话给出的方向」出现两次，末尾一整段把前面的论点又讲一遍。
 * 稿台自己写出来的稿子自己看着难受，就不能指望用户自己看出来。
 *
 * 注意：这里检出的重复只报给用户看，稿台不会自己动手改。
 * 自动改写那一套机器已经拆掉了（见 src/lib/article-review.ts）。
 */

suite("重复检测", ({ test }) => {
  test("同一句话出现两次要报出来", () => {
    const text = [
      "代码行数确实变短了。工时没有。省下来的时间流向了别的地方。",
      "调试的时间没有减少，评审的时间也没有减少。",
      "省下的时间流向了别的地方。",
    ].join("\n");
    const items = findRepetitions(text);
    // 这两句不是逐字相同（「省下来」对「省下」），但说的是同一件事。
    const near = items.filter(item => item.kind === "near");
    assertTrue(near.length >= 1, "说的是同一件事的两句要被报出来");
    assertEqual(near[0].level, "fail", "相似到这个程度就是硬禁令");
  });

  test("逐字相同的句子报成逐字重复", () => {
    const text = [
      "他说时间省下来了，改代码的活儿一点没少。",
      "调试的时间没有减少，评审的时间也没有减少。",
      "他说时间省下来了，改代码的活儿一点没少。",
    ].join("\n");
    const items = findRepetitions(text);
    const exact = items.filter(item => item.kind === "exact");
    assertTrue(exact.length >= 1, "逐字重复的那句要被报出来");
    assertEqual(exact[0].level, "fail", "逐字重复是硬禁令");
  });

  test("高度相似的句子要报出来", () => {
    const text = [
      "调试没有减少，生成速度快了改坏的次数反而更多。",
      "验收也没有减少，代码行数少了逻辑反而更分散。",
      "调试没有减少，生成速度快了改坏的次数反而更多一些。",
    ].join("\n");
    const items = findRepetitions(text);
    const near = items.filter(item => item.kind === "near");
    assertTrue(near.length >= 1, "高度相似的两句要被报出来");
  });

  test("干净的稿子不报重复", () => {
    const text = [
      "那天他坐在工位上看完最后一行日志，把笔记本合上，跟同事说了句先吃饭。",
      "第二天他换了个位置，屏幕上还留着昨天没关的告警面板。",
      "他没点开那堆邮件，先把昨天记下的三条问题抄在便签上。",
    ].join("\n");
    const items = findRepetitions(text);
    assertEqual(items.filter(item => item.level === "fail").length, 0, "不该有硬禁令级别的重复");
  });

  test("体检把重复算成硬禁令", () => {
    const text = ["他说时间省下来了，改代码的活儿一点没少。", "他说时间省下来了，改代码的活儿一点没少。"].join("\n");
    const result = checkProse(text);
    const repetition = result.findings.filter(item => item.kind === "repetition");
    assertTrue(repetition.length >= 1, "体检要报重复");
    assertTrue(!result.ok, "重复是硬禁令，稿子不能就这么交出去");
  });

  test("相似度对完全相同的句子是 1，对不相干的是 0", () => {
    assertEqual(similarity("省下的时间流向了别的地方", "省下的时间流向了别的地方"), 1);
    assertTrue(similarity("他坐在工位上看日志", "她在会议室里改需求") < 0.2, "不相干的句子相似度要低");
  });
});

/**
 * 包含度：长句包着短句时，Jaccard 是瞎的。
 *
 * 真模型成稿里的实例：第 13 行「工作量本身没有减少。」
 * 在第 69 行「AI 编程助手改变的是工作内容的结构，工作量本身没有减少。」里
 * 又说了一遍。Jaccard 只有 0.33（看不出来），包含度是 1.00（一目了然）。
 */
suite("包含度判据", ({ test }) => {
  test("长句包着短句，包含度要看得出来", () => {
    const short = "工作量本身没有减少";
    const long = "AI编程助手改变的是工作内容的结构工作量本身没有减少";
    assertEqual(containment(short, long), 1, "短句整个落在长句里，包含度是 1");
    assertTrue(similarity(short, long) < 0.6, "同样的例子，Jaccard 看不出来");
  });

  test("不相干的两句，包含度要低", () => {
    assertTrue(containment("他坐在工位上看日志", "她在会议室里改需求") < 0.3, "不相干的包含度要低");
  });

  test("九个字以下的短句不算包含", () => {
    const items = findRepetitions(
      ["这句话很短。", "他抬头看了一眼墙上的钟，又低头继续改那个函数。", "这句话很短。"].join("\n"),
    );
    assertEqual(items.filter(item => item.kind === "contain").length, 0, "太短的句子不比包含度");
  });
});

/**
 * 跨标点的重复片段必须报出来。
 *
 * 真模型成稿里那段 27 字的原话被引了两次，两次都带逗号。
 * 早先的滑窗一跨过标点就整窗丢掉，于是这处重复一次都没报出来过。
 */
suite("跨标点的重复片段", ({ test }) => {
  test("带逗号的重复片段要报出来，长度按片段算", () => {
    const quote = "写代码的时间省下来了，改代码的活儿一点没少，最后还在他桌上";
    const text = [
      `一位老工程师对这件事的判断只有一句话，「${quote}」。`,
      "中间隔了另外一段完全不相干的话，把两边拉开足够远，免得被当成相邻重复。",
      "再补一句别的，让两处的距离稳稳地超过门槛，检测才有意义。",
      `老工程师的原话是「${quote}」。这句话不情绪化，也不夸张。`,
    ].join("\n");
    const items = findRepetitions(text);
    const phrase = items.filter(item => item.kind === "phrase");
    assertTrue(phrase.length >= 1, "带标点的重复片段要被报出来");
    const hit = phrase.find(item => item.excerpt.includes("写代码的时间省下来了"));
    assertTrue(!!hit, "要报到那段引文本身");
    assertTrue(hit!.excerpt.length <= 60, "片段要截断，不能把两处之间的正文也切进来");
    assertTrue(hit!.excerpt.length >= 25, "片段的长度按重复的部分算，不按两处之间的距离算");
  });

  test("重复片段的长度不能把两处之间的正文算进去", () => {
    const items = findRepetitions(
      [
        "开头一句完全不相干的话，先把这里填满，让两处之间的距离足够远。",
        "再垫一句，还是不相干，只是为了让距离更远一些，检测才有意义。",
        "然后是那句被重复的话：写代码的时间省下来了。",
        "中间又垫了好多不相干的句子，把两处远远地隔开，中间隔了足足几百个字。",
        "最后再重复一次：写代码的时间省下来了。",
      ].join("\n"),
    );
    const phrase = items.filter(item => item.kind === "phrase");
    for (const item of phrase) {
      assertTrue(item.excerpt.length <= 60, "片段不能长到把中间的正文也包进来");
    }
  });
});

/**
 * 机械去重的第二步：抽片段。
 *
 * 一句包着另一句时，把重复的那一段从长句里抽掉，两边的新信息都留着。
 * 抽掉之后那句话必须还读得通。
 */
suite("抽片段去重", ({ test }) => {
  test("长句里重复的那一段要被抽掉，两边新信息都留着", () => {
    const text = [
      "真正被削减的是工作类型。工作量本身没有减少。",
      "调试和验收占用的时间没有减少。返工的成本要从别处补。",
      "AI 编程助手改变的是工作内容的结构，工作量本身没有减少。它搬走了写的一部分。",
    ].join("\n");
    const result = dedupeRepeatedSentences(text);
    assertTrue(result.removed.length >= 1, "重复的那一段要被抽掉");
    assertTrue(!result.content.includes("工作量本身没有减少。\n\nAI"), "长句里那半句要没了");
    assertTrue(result.content.includes("AI 编程助手改变的是工作内容的结构"), "长句的新信息要留着");
    assertTrue(result.content.includes("工作量本身没有减少。\n\nAI") === false, "抽掉后不留双份");
  });

  test("引文里的重复不抽，留着让人看", () => {
    const quote = "写代码的时间省下来了，改代码的活儿一点没少";
    const text = [
      `一位老工程师说过一句话：「${quote}」。`,
      "中间隔了另外一段完全不相干的话，把两边拉开足够远，免得被当成相邻重复。",
      "再补一句别的，让两处的距离稳稳地超过门槛，检测才有意义。",
      `老工程师的原话是「${quote}」。这句话不情绪化。`,
    ].join("\n");
    const result = dedupeRepeatedSentences(text);
    assertEqual(result.removed.length, 0, "引文里的重复不自动抽");
    assertTrue(result.content.includes(quote), "引文原样留着");
  });

  test("旁注不参与自动改写", () => {
    const text = [
      "这一节先说清楚一件事：材料只给了三条确认过的事实。",
      "材料能确认的有三条。调试和验收占用的时间没有减少。",
      "> 需核实（材料没有说明离开的两个人是什么级别，走的是新人还是资深工程师。）",
      "工具本身没有说明离开的两个人是什么级别，走的是新人还是资深工程师。",
    ].join("\n");
    const result = dedupeRepeatedSentences(text);
    assertTrue(result.content.includes("需核实"), "旁注原样留着");
  });

  test("去重之后不该再有硬禁令级别的重复", () => {
    const text = [
      "代码行数确实变短了。工时没有。省下来的时间流向了别的地方。",
      "调试的时间没有减少，评审的时间也没有减少。",
      "省下的时间流向了别的地方。",
      "真正被削减的是工作类型。工作量本身没有减少。",
      "调试和验收占用的时间没有减少。返工的成本要从别处补。",
      "AI 编程助手改变的是工作内容的结构，工作量本身没有减少。它搬走了写的一部分。",
    ].join("\n");
    const result = dedupeRepeatedSentences(text);
    const after = findRepetitions(result.content);
    assertEqual(after.filter(item => item.level === "fail").length, 0, "去重之后不该还有硬禁令级别的重复");
  });
});

suite("机械去重", ({ test }) => {
  test("删掉后面重复的那句，保留第一句", () => {
    const text = [
      "代码行数确实变短了。工时没有。省下来的时间流向了别的地方。",
      "调试的时间没有减少，评审的时间也没有减少。",
      "省下的时间流向了别的地方。",
    ].join("\n");
    const result = dedupeRepeatedSentences(text);
    assertTrue(result.removed.length >= 1, "重复的句子要被删掉");
    assertTrue(!result.content.includes("省下的时间流向了别的地方"), "后面那句重复的删掉");
    assertTrue(result.content.includes("省下来的时间流向了别的地方"), "第一次出现的那句要留着");
  });

  test("去重不动别的地方", () => {
    const text = [
      "调试的时间没有减少，评审的时间也没有减少。",
      "他抬头看了一眼墙上的钟，又低头继续改那个函数。",
    ].join("\n");
    const result = dedupeRepeatedSentences(text);
    assertEqual(result.removed.length, 0, "没有重复就不该删东西");
    assertEqual(result.content, text, "没有重复时正文一个字都不动");
  });

  test("删掉之后不留下空段", () => {
    const text = ["他抬头看了一眼墙上的钟。", "他抬头看了一眼墙上的钟。"].join("\n\n");
    const result = dedupeRepeatedSentences(text);
    assertEqual(result.removed.length, 1);
    assertEqual(result.content.trim(), "他抬头看了一眼墙上的钟。", "空段要收掉");
  });
});

suite("模型退化重复", ({ test }) => {
  test("同一行连续四次判为退化", () => {
    const hit = findDegenerateRepetition(["可以", "可以", "可以", "可以"].join("\n"));
    assertTrue(Boolean(hit), "应判为退化重复");
    assertEqual(hit?.kind, "lines");
  });

  test("短单位连续刷屏判为退化", () => {
    const hit = findDegenerateRepetition("可以可以可以可以可以可以可以可以");
    assertTrue(Boolean(hit), "应判为退化重复");
    assertEqual(hit?.kind, "unit");
  });

  test("正常语境里的重复不误报", () => {
    const text = "他说可以。\n\n我也说可以，但得等一等。";
    assertEqual(findDegenerateRepetition(text), null);
  });

  test("代码块里的重复不误报", () => {
    const text = "```\n可以\n可以\n可以\n可以\n```";
    assertEqual(findDegenerateRepetition(text), null);
  });
});
