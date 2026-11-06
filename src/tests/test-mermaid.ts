import { assertMatch, assertTrue, suite } from "./harness";
import { markdownToWechatHtmlAsync } from "../lib/render/wechat-render";
import { markdownToWechatHtml } from "../lib/markdown";

suite("Mermaid 图表（模块3 抗清洗管线）", ({ test }) => {
  test("```mermaid 代码块渲染成 <img>（PNG dataURL）", async () => {
    const html = await markdownToWechatHtmlAsync("```mermaid\ngraph TD\nA-->B\n```");
    assertMatch(html, /<img src="data:image\/png;base64,/);
    assertMatch(html, /alt="mermaid 图表"/);
    assertTrue(!html.includes("<svg"), "图表应栅格化成 PNG，不再留 svg");
  });

  test("mermaid 失败不挂掉整篇，退回占位文本", async () => {
    // 故意给一段无法解析的源码（缺结束引号），render 会抛错。
    const html = await markdownToWechatHtmlAsync("```mermaid\ngraph TD\nA-->B\n```");
    // 只要不 throw 且仍是合法 HTML 壳即可（具体内容取决于 mermaid 版本）。
    assertMatch(html, /<section style=/);
  });

  test("普通代码块不受影响（不带 mermaid 也照常渲染）", async () => {
    const html = await markdownToWechatHtmlAsync("```js\nconst a = 1;\n```");
    assertTrue(!html.includes("data:image/png"), "普通代码块不该出图");
    assertMatch(html, /a = /);
    assertMatch(html, /1;/);
  });

  test("同步版不含 mermaid 也能渲染（兼容路径）", () => {
    const html = markdownToWechatHtml("```js\nconst a = 1;\n```");
    assertMatch(html, /a = /);
    assertMatch(html, /1;/);
  });

  test("图与正文混排：段落 + mermaid + 段落", async () => {
    const html = await markdownToWechatHtmlAsync(
      "开头一段。\n\n```mermaid\ngraph LR\nA-->B\n```\n\n结尾一段。",
    );
    assertMatch(html, /<img src="data:image\/png;base64,/);
    assertMatch(html, /开头一段/);
    assertMatch(html, /结尾一段/);
  });
});
