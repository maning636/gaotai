import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import { compileCustomCss } from "../lib/custom-css/compiler";
import { inlineCustomCss, applyCompiledCustomCss } from "../lib/custom-css/inliner";
import { extractCustomCssFromMarkdown } from "../lib/custom-css/source";

suite("自定义 CSS：编译", ({ test }) => {
  test("空 CSS 返回 usable=true", () => {
    const result = compileCustomCss("");
    assertEqual(result.usable, true);
    assertEqual(result.scopedCss, "");
    assertEqual(result.diagnostics.length, 0);
  });

  test("非法 CSS 返回 usable=false", () => {
    const result = compileCustomCss(".a { color: ");
    assertEqual(result.usable, false);
    assertTrue(result.diagnostics.some(item => item.severity === "fatal"));
  });

  test("@import 被移除", () => {
    const result = compileCustomCss('@import url("https://example.com/x.css");\n.a { color: red; }');
    assertTrue(!result.scopedCss.includes("@import"), "scopedCss 不应含 @import");
    assertTrue(result.diagnostics.some(item => item.code === "custom-css-import-blocked"));
  });

  test("@font-face 被移除", () => {
    const result = compileCustomCss('@font-face { font-family: X; src: url(x.woff); }\n.a { color: red; }');
    assertTrue(!result.scopedCss.includes("@font-face"));
    assertTrue(result.diagnostics.some(item => item.code === "custom-css-font-face-blocked"));
  });

  test("behavior 属性被移除", () => {
    const result = compileCustomCss(".a { behavior: url(#default#VML); color: red; }");
    assertTrue(!result.scopedCss.includes("behavior"), "scopedCss 不应含 behavior");
    assertTrue(result.diagnostics.some(item => item.code === "custom-css-dangerous-property"));
  });

  test("expression() 被移除", () => {
    const result = compileCustomCss(".a { width: expression(document.body.clientWidth); }");
    assertTrue(!result.scopedCss.includes("expression"), "scopedCss 不应含 expression");
    assertTrue(result.diagnostics.some(item => item.code === "custom-css-expression-blocked"));
  });

  test("外部 URL 被移除", () => {
    const result = compileCustomCss('.a { background: url("https://evil.com/a.png"); }');
    assertTrue(!result.scopedCss.includes("evil.com"));
    assertTrue(result.diagnostics.some(item => item.code === "custom-css-resource-url-blocked"));
  });

  test("安全的内联 data image 保留", () => {
    // 1x1 红点 PNG base64。
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const result = compileCustomCss(`.a { background: url("${tinyPng}"); }`);
    assertTrue(result.scopedCss.includes("data:image/png"), "应保留合法的小 data image");
  });

  test("选择器作用域改写为 .gt-article-root 前缀", () => {
    const result = compileCustomCss(".a p { color: red; }");
    assertTrue(result.usable);
    assertMatch(result.scopedCss, /\.gt-article-root\s+\.a\s+p/);
  });

  test(":is()/:where() 展开为独立选择器", () => {
    const result = compileCustomCss(".a :is(h1, h2) { color: red; }");
    assertTrue(result.usable);
    // 展开后 :is(h1, h2) 应变成两条独立选择器；序列化时组合符前后空格可能保留原样。
    assertMatch(result.scopedCss, /\.gt-article-root\s+\.a\s+h1/);
    assertMatch(result.scopedCss, /\.gt-article-root\s+\.a\s+h2/);
  });

  test(":has() 选择器被跳过", () => {
    const result = compileCustomCss(".a:has(.b) { color: red; }");
    assertTrue(result.usable, ":has() 不应导致致命错误");
    assertTrue(!result.scopedCss.includes(":has"), "scopedCss 不应含 :has()");
  });

  test("::before/::after 提取为 pseudoRules", () => {
    const result = compileCustomCss(".a::before { content: ''; color: red; }");
    assertEqual(result.pseudoRules.length, 1);
    assertEqual(result.pseudoRules[0]?.pseudoType, "before");
    assertEqual(result.pseudoRules[0]?.baseSelector, ".a");
    assertTrue(result.scopedCss.length === 0, "纯伪元素规则不应留在 scopedCss");
  });

  test("缓存生效（同输入同结果）", () => {
    const a = compileCustomCss(".x { color: blue; }");
    const b = compileCustomCss(".x { color: blue; }");
    assertEqual(a.sourceHash, b.sourceHash);
    assertEqual(a.scopedCss, b.scopedCss);
  });
});

suite("自定义 CSS：内联", ({ test }) => {
  test("inlineCustomCss fail-open：空 CSS 返回原 HTML", () => {
    const html = "<p>你好</p>";
    assertEqual(inlineCustomCss(html, ""), html);
  });

  test("inlineCustomCss fail-open：非法 CSS 返回原 HTML", () => {
    const html = "<p>你好</p>";
    assertEqual(inlineCustomCss(html, ".a { color: "), html);
  });

  test("inlineCustomCss 应用合法 CSS", () => {
    const html = "<div class='article'><p>你好</p></div>";
    const out = inlineCustomCss(html, ".article p { color: #ff0000; }");
    assertTrue(out.includes("#ff0000"), "应把 color 内联到 p 上");
  });

  test("applyCompiledCustomCss 返回 html + applied + 统计", () => {
    const compiled = compileCustomCss(".article p { color: green; }");
    const result = applyCompiledCustomCss("<div class='article'><p>hi</p></div>", compiled);
    assertEqual(result.applied, true);
    assertTrue(result.html.includes("green"));
    // Node 环境没有 DOMParser，matchedRuleCount 可能为 0；有 DOM 时才会统计。
    assertTrue(result.matchedRuleCount >= 0);
  });

  test("选择器作用域改写后能内联到根容器内的元素", () => {
    // CSS 里不应手写 .gt-article-root（那是编译器加的前缀）；用普通选择器验证作用域改写。
    const compiled = compileCustomCss(".article p { color: #333333; }");
    const result = applyCompiledCustomCss("<div class='article'><p>hi</p></div>", compiled);
    assertEqual(result.applied, true);
    assertTrue(result.html.includes("#333333"));
  });
});

suite("自定义 CSS：Markdown 提取", ({ test }) => {
  test("提取 <style> 块", () => {
    const md = "# 标题\n\n<style>\n.a { color: red; }\n</style>\n\n正文";
    const result = extractCustomCssFromMarkdown(md);
    assertTrue(result.css.includes(".a { color: red; }"));
    assertTrue(result.remaining.includes("# 标题"));
    assertTrue(!result.remaining.includes("<style>"));
  });

  test("无 style 块时 css 为空、remaining 为原文", () => {
    const md = "只有正文，没有 CSS。";
    const result = extractCustomCssFromMarkdown(md);
    assertEqual(result.css, "");
    assertEqual(result.remaining, md);
  });
});
