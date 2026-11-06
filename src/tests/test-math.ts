import { assertMatch, assertTrue, suite } from "./harness";
import { renderMath } from "../lib/render/math";
import { markdownToWechatHtmlAsync } from "../lib/render/wechat-render";

suite("LaTeX 公式（模块3 抗清洗管线）", ({ test }) => {
  test("行内公式 $E=mc^2$ 渲染为自包含 SVG", () => {
    const svg = renderMath("E=mc^2", false);
    assertMatch(svg, /<svg/);
    assertMatch(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assertMatch(svg, /viewBox=/);
  });

  test("块级公式 $$\\int_0^1 x\\,dx$$ 渲染为自包含 SVG", () => {
    const svg = renderMath("\\int_0^1 x\\,dx", true);
    assertMatch(svg, /<svg/);
    assertMatch(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  test("化学式 \\ce{H2O} 能渲染（mhchem 宏包已引）", () => {
    const svg = renderMath("\\ce{H2O}", false);
    assertMatch(svg, /<svg/);
  });

  test("非法公式不抛错（noerrors 包兜底），返回字符串", () => {
    // 关键性质：公式写错不能把整篇渲染炸掉。noerrors/noundefined 包会
    // 让 mathjax 尽力渲染（可能返回错误框的 SVG），也可能返回空串——
    // 两种都不该抛错，且返回的一定是字符串。
    const svg = renderMath("\\frac{", true);
    assertTrue(typeof svg === "string", "非法公式应返回字符串而非抛错");
  });

  test("整篇渲染：$...$ 与 $$...$$ 都变成 SVG", async () => {
    const html = await markdownToWechatHtmlAsync("质能方程 $E=mc^2$ 与积分 $$\\int_0^1 x\\,dx$$ 放一起。");
    assertMatch(html, /<svg/);
  });

  test("不含 $ 的文本不受影响，仍能正常渲染段落", async () => {
    const html = await markdownToWechatHtmlAsync("一段普通文字，没有公式。");
    assertMatch(html, /一段普通文字/);
    assertTrue(!html.includes("<svg"), "没有公式就不该有 svg");
  });

  test("代码块里的 $ 不会被当成公式", async () => {
    const html = await markdownToWechatHtmlAsync("```js\nconst price = $5;\n```");
    assertTrue(!html.includes("<svg"), "代码里的 $ 不是公式");
    assertMatch(html, /\$5;/);
  });
});
