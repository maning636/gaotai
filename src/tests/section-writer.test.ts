import { assertEqual, assertTrue, suite } from "./harness";
import {
  buildSectionWriteMessages,
  fallbackHeading,
  planSectionWriting,
  splitSectionOutput,
} from "../lib/section-writer";
import { parseOutlineParagraphs } from "../lib/length-target";

/**
 * 分节生成。
 *
 * 这条能力是被真模型逼出来的（2026-10-23）：
 * 一次性写 3500 字的请求，同一条连着跑 4 次，3 次一个字都没交出来，
 * 交出来的那次只写了 2066 字——正好是上下文里上一稿的 2068 字。
 * 也就是说一次性写长文既不稳，长度也由不得人定。
 *
 * 分开写就把这两件事解决了：每节几百字，交得出正文；
 * 每节有自己独立的字数账，说「控制在 360 字上下」实测能命中。
 */

/** 一份真实形状的大纲：两段，各自带字数账。 */
const OUTLINE = [
  "> **第 1 段·钩子（200-240 字）**",
  "> 目的：用具体数字抓住读者，同时制造悬念。",
  "> 内容：800 行→300 行的对比，但省下的时间没有变成休息。",
  "> 素材：材料第 3 段的对比数据。",
  "> 形式：数据 + 反问。",
  "",
  "> **第 2 段·立论（240-280 字）**",
  "> 目的：亮出核心主张，用老工程师的原话做锚点。",
  "> 内容：AI 编程助手没有减少工作量，而是把工作从「写」转移到了「改」。",
  "> 素材：材料第 3 段老工程师的判断。",
  "> 形式：引用 + 判断。",
].join("\n");

suite("分节生成", ({ test }) => {
  test("每节从大纲里领自己的字数账", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE);
    const plans = planSectionWriting({ paragraphs, totalTarget: 1000 });
    assertEqual(plans.length, 2);
    // 200–240 的中值是 220。
    assertEqual(plans[0].target, 220);
    assertEqual(plans[1].target, 260);
  });

  test("大纲没写字数的那几段按全文目标平分", () => {
    const paragraphs = parseOutlineParagraphs(
      ["> **第 1 段·钩子**", "> 目的：抓住读者。", "", "> **第 2 段·立论**", "> 目的：亮出主张。"].join("\n"),
    );
    const plans = planSectionWriting({ paragraphs, totalTarget: 1000 });
    assertEqual(plans.length, 2);
    assertEqual(plans[0].target, 500);
    assertEqual(plans[1].target, 500);
  });

  test("请求里只给本节的要求、外加一份结构清单", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE);
    const plans = planSectionWriting({ paragraphs, totalTarget: 1000 });
    const messages = buildSectionWriteMessages({
      plan: plans[0],
      index: 0,
      total: 2,
      outline: paragraphs,
      facts: "- （材料第 3 段）2023 年写一个中等功能模块约 800 行代码。",
    });
    const user = messages[1].content;

    assertTrue(user.includes("控制在 220 字上下"), "要给出这一节的字数");
    assertTrue(user.includes("用具体数字抓住读者"), "要给出本节的目的");
    assertTrue(user.includes("800 行→300 行"), "要给出本节要写的内容");
    assertTrue(user.includes("材料第 3 段的对比数据"), "要给出本节要用的素材");
    assertTrue(user.includes("800 行代码"), "要给出可以用的事实");
    assertTrue(user.includes("不要小标题"), "第一节不加小标题");
    assertTrue(user.includes("不用中文冒号"), "硬规则要带进请求");
    // 别的节只给一句话当上下文，不把整份大纲的施工说明塞进来——
    // 施工说明给全了，模型会去逐条核对，额度全被思考吃光，正文一个字没有。
    assertTrue(user.includes("2. 第 2 段·立论：亮出核心主张"), "结构清单里要有别节的一句话");
    assertTrue(!user.includes("素材：材料第 3 段老工程师的判断"), "别节的施工说明不能进请求");
  });

  test("第二节要接上一节，但不重复它的正文", () => {
    const paragraphs = parseOutlineParagraphs(OUTLINE);
    const plans = planSectionWriting({ paragraphs, totalTarget: 1000 });
    const user = buildSectionWriteMessages({
      plan: plans[1],
      index: 1,
      total: 2,
      outline: paragraphs,
      previous: paragraphs[0],
    })[1].content;

    assertTrue(user.includes("上一段"), "要交代上一段");
    assertTrue(user.includes("##"), "第二节要小标题");
    assertTrue(user.includes("不要重复上一段讲过的内容"), "不能照抄上一段");
  });

  test("模型交回来的小标题和正文要拆开", () => {
    const first = splitSectionOutput("好的，下面是这一节。\n\n开头这句话先摆出来。", 0);
    assertEqual(first.heading, "");
    assertEqual(first.body, "开头这句话先摆出来。");

    const second = splitSectionOutput("## 300 行的代价去了哪里\n\n省下来的 500 行没有变成下班时间。", 1);
    assertEqual(second.heading, "300 行的代价去了哪里");
    assertEqual(second.body, "省下来的 500 行没有变成下班时间。");
  });

  test("模型没给小标题时，用大纲里的角色名兜底", () => {
    assertEqual(fallbackHeading({ label: "第 2 段·立论（240-280 字）" } as never), "立论");
    assertEqual(fallbackHeading({ label: "第 3 段" } as never), "正文");
  });
});
