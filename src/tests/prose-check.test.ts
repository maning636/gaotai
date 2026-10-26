import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import {
  checkProse,
  lastAssistantText,
  proseCheckTool,
  renderProseReport,
  runProseCheck,
} from "../lib/prose-check";

/**
 * 成稿体检的测试。
 *
 * 规则来自 MIT 授权的 human-writing 技能包自带的 check_prose.py，
 * 这里锁住的是行为：硬禁令要报出来，干净的稿子不能误伤。
 */

/** 找出某一类别的命中。 */
function kinds(result: ReturnType<typeof checkProse>): string[] {
  return result.findings.map(item => item.kind);
}

suite("成稿体检", ({ test }) => {
  test("干净的稿子不该报出硬禁令", () => {
    const result = checkProse(
      [
        "我在这行干了六年。",
        "最早那会儿我们只有三个人，租的是一间地下室，夏天热得没法待。",
        "现在回头看，那几年其实没什么技术含量，卖的是时间。",
        "但客户认的是你这个人，不是你用的那个框架。",
        "这行当下来，最值钱的还是把事情做到底的耐心。",
      ].join("\n"),
    );
    assertTrue(result.hanCount > 0);
    assertTrue(result.ok, `不该有硬禁令：${JSON.stringify(result.findings.filter(f => f.level === "fail"))}`);
  });

  test("中文冒号算硬禁令", () => {
    const result = checkProse("这件事有三个原因：第一是成本，第二是时间，第三是人。");
    assertTrue(kinds(result).includes("punctuation"));
    assertTrue(!result.ok);
  });

  test("引出原话的冒号只算提醒", () => {
    const result = checkProse("他说：「这个方向不对」，然后就没再说话。");
    const punctuation = result.findings.filter(item => item.kind === "punctuation");
    assertEqual(punctuation.length, 1);
    assertEqual(punctuation[0].level, "warn");
    assertTrue(result.ok, "引出原话的冒号不该算硬禁令");
  });

  test("破折号算硬禁令", () => {
    const result = checkProse("这个决定——来得太突然了。");
    assertTrue(!result.ok);
    assertTrue(kinds(result).includes("punctuation"));
  });

  test("中文破折号连写两个字符也算一处", () => {
    const result = checkProse("这个决定——来得太突然了。");
    const found = result.findings.find(item => item.kind === "punctuation");
    assertTrue(Boolean(found));
    assertMatch(found!.message, /共 1 处/);
    // 同一行只报一次行号，不能出现「第 1、1 行」
    assertMatch(found!.message, /第 1 行/);
    assertTrue(!found!.message.includes("1、1"), `行号重复：${found!.message}`);
  });

  test("翻案句算硬禁令", () => {
    const result = checkProse("这不是一次失败，而是一次重新开始。");
    assertTrue(kinds(result).includes("pivot"));
    assertTrue(!result.ok);
  });

  test("硬停词被点名", () => {
    const result = checkProse("说白了，这件事没那么复杂。");
    const found = result.findings.find(item => item.kind === "hard-stop");
    assertTrue(Boolean(found));
    assertMatch(found!.message, /说白了/);
  });

  test("绝对禁用黑话被点名", () => {
    const result = checkProse("我们要通过技术底座完成一次全链路的业务赋能。");
    assertTrue(kinds(result).includes("hard-jargon"));
  });

  test("需要辨语境的词只算提醒", () => {
    const result = checkProse("这套方法沉淀了三年，后来成了团队的日常。");
    const found = result.findings.find(item => item.kind === "context-jargon");
    assertTrue(Boolean(found));
    assertEqual(found!.level, "warn");
  });

  test("模型路标被点名", () => {
    const result = checkProse("值得注意的是，这件事其实没那么简单。");
    assertTrue(kinds(result).includes("road-sign"));
  });

  test("代码块与链接不参与检查，位置仍然对得上", () => {
    const text = ["```", "const a = 1; // 赋能 抓手 闭环", "```", "", "他说「好的」。"].join("\n");
    const result = checkProse(text);
    assertTrue(!kinds(result).includes("hard-jargon"), "代码块里的黑话不该被算进来");
  });

  test("行号指向原文的正确位置", () => {
    const text = ["第一行没问题。", "第二行有问题：这里有冒号。"].join("\n");
    const result = checkProse(text);
    const found = result.findings.find(item => item.kind === "punctuation");
    assertTrue(Boolean(found));
    assertEqual(found!.line, 2);
  });

  test("三连同构排比被点名", () => {
    // 同一句里、三个小句、开头两个字相同，才算同构排比。
    const result = checkProse("我在北京，我在上海，我在这行待了六年。");
    assertTrue(kinds(result).includes("anaphora"));
  });

  test("不同开头的小句不算同构排比", () => {
    const result = checkProse("他写了代码，他改了代码，他又删了代码。");
    assertTrue(!kinds(result).includes("anaphora"));
  });

  test("名词化句式被点名", () => {
    const result = checkProse("我们对流程进行了一次梳理和优化。");
    assertTrue(kinds(result).includes("nominalization"));
  });

  test("没有汉字时什么都不报", () => {
    const result = checkProse("hello world 123");
    assertEqual(result.hanCount, 0);
    assertEqual(result.findings.length, 0);
    assertTrue(result.ok);
  });

  test("统计里能看到各类命中数", () => {
    const result = checkProse("说白了，这不是失败，而是转机。");
    assertTrue((result.summary["硬停词"] ?? 0) >= 1);
    assertTrue((result.summary["翻案句"] ?? 0) >= 1);
  });

  test("报告文本分两档写清楚", () => {
    const hard = checkProse("说白了，这不是失败，而是转机。");
    assertMatch(renderProseReport(hard), /必须修改/);

    const soft = checkProse("真正，本质上，归根结底，这三点都要改。");
    assertMatch(renderProseReport(soft), /需要人工判断/);
  });

  test("干净的稿子的报告是「通过」", () => {
    const result = checkProse("我在这个行当待了很多年，见过不少人来，也见过不少人走。");
    assertMatch(renderProseReport(result), /体检通过/);
  });
});

suite("体检工具", ({ test }) => {
  test("工具名固定为 check_prose", () => {
    assertEqual(proseCheckTool.type, "function");
    assertEqual(proseCheckTool.function.name, "check_prose");
    assertMatch(proseCheckTool.function.description, /不联网/);
  });

  test("不传 text 时检查上一条助手消息", () => {
    const messages = [
      { role: "user" as const, content: "写一段" },
      { role: "assistant" as const, content: "说白了，这事不复杂。" },
    ];
    const output = runProseCheck({}, { messages });
    assertMatch(output, /硬停词/);
  });

  test("传了 text 就检查传的这段", () => {
    const output = runProseCheck({ text: "这是一句干净的中文，没有违禁项。" }, { messages: [] });
    assertMatch(output, /体检通过/);
  });

  test("找不到可检查的正文时如实说", () => {
    const output = runProseCheck({}, { messages: [] });
    assertMatch(output, /没有可检查的正文/);
  });

  test("取最近一条助手消息", () => {
    const messages = [
      { role: "assistant" as const, content: "第一版" },
      { role: "user" as const, content: "再来" },
      { role: "assistant" as const, content: "第二版" },
    ];
    assertEqual(lastAssistantText(messages), "第二版");
  });
});
