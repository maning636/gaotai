import { assertMatch, assertTrue, suite } from "./harness";
import { highlightCode } from "../lib/render/code-highlight";

suite("代码高亮（模块3 抗清洗管线）", ({ test }) => {
  test("highlightCode 返回带内联 style 的 HTML", () => {
    const html = highlightCode("const a = 1;", "js");
    // 关键字 const 应被包进带 color 的 span
    assertMatch(html, /<span style="color: #ff7b72;">const<\/span>/);
    assertMatch(html, /color: #79c0ff/); // 数字 1 也是彩色
  });

  test("未知语言返回转义后的纯文本，不丢内容", () => {
    const html = highlightCode("<div> & </div>", "no-such-lang");
    assertTrue(!html.includes("<div>"), "不能透传成真标签");
    assertMatch(html, /&lt;div&gt; &amp; &lt;\/div&gt;/);
  });

  test("换行被转成显式 br，不依赖平台保留 pre 空白", () => {
    const html = highlightCode("const a = 1;\nconst b = 2;", "js");
    assertMatch(html, /<br \/>/);
    assertTrue(!html.includes("\n"), "高亮输出里不该有裸换行符");
  });

  test("语言别名能匹配（ts 与 typescript 同高亮）", () => {
    const html = highlightCode("let x: number = 1;", "ts");
    assertMatch(html, /<span style="color: #ff7b72;">let<\/span>/);
  });
});
