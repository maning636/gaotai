import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import {
  escapeHtml,
  extractFirstImage,
  extractHeadings,
  extractSummary,
  extractTitle,
  markdownToPlainText,
  markdownToWechatHtml,
  normalizeThemeId,
  THEME_NAMES,
  type ThemeId,
} from "../lib/markdown";

suite("Markdown 渲染", ({ test }) => {
  test("文本节点被转义，脚本不会变成可执行标签", () => {
    const html = markdownToWechatHtml("正文 <script>alert(1)</script> 结束");
    assertTrue(!html.includes("<script>"), "输出里不能出现可执行的 script 标签");
    assertMatch(html, /&lt;script&gt;/);
  });

  test("输出里没有任何 class 属性（公众号不接受）", () => {
    const html = markdownToWechatHtml("# 标题\n\n段落\n\n- 列表项\n\n> 引用");
    assertTrue(!/\bclass\s*=/.test(html), "不能出现 class 属性");
  });

  test("正文自带内联样式，段落有行距", () => {
    const html = markdownToWechatHtml("一段普通文字。");
    assertMatch(html, /<p style="[^"]*line-height: 1\.75/);
    assertMatch(html, /<section style="/);
  });

  test("标题层级被映射成 h1-h4", () => {
    const html = markdownToWechatHtml("# 一级\n\n## 二级\n\n### 三级\n\n#### 四级");
    assertMatch(html, /<h1 style=/);
    assertMatch(html, /<h2 style=/);
    assertMatch(html, /<h3 style=/);
    assertMatch(html, /<h4 style=/);
  });

  test("图片带 max-width，装饰开关生效", () => {
    const plain = markdownToWechatHtml("![说明](https://example.com/a.png)");
    assertMatch(plain, /<img src="https:\/\/example\.com\/a\.png"/);
    assertMatch(plain, /max-width: 100%/);

    const decorated = markdownToWechatHtml("![说明](https://example.com/a.png)", { decorateImages: true });
    assertMatch(decorated, /border-radius: 4px/);
  });

  test("图片带 data-s 与 data-type，供公众号后台认图", () => {
    const html = markdownToWechatHtml("![说明](https://example.com/a.png)");
    assertMatch(html, /data-s="https:\/\/example\.com\/a\.png"/);
    assertMatch(html, /data-type="image"/);
  });

  test("链接保留 href，属性被转义", () => {
    const html = markdownToWechatHtml('[点我](https://example.com/?a=1&b="2")');
    assertMatch(html, /<a href="https:\/\/example\.com\/\?a=1&amp;b=&quot;2&quot;"/);
  });

  test("表格被渲染成 table 结构", () => {
    const html = markdownToWechatHtml("| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |");
    assertMatch(html, /<table style=/);
    assertMatch(html, /<th style=/);
    assertMatch(html, /<td style=/);
    assertMatch(html, /甲/);
  });

  test("列表、引用、代码块都成结构", () => {
    const html = markdownToWechatHtml("- 一\n- 二\n\n> 引用一句\n\n```js\nconst a = 1;\n```");
    assertMatch(html, /<ul style=/);
    assertMatch(html, /<li style=/);
    assertMatch(html, /<blockquote style=/);
    assertMatch(html, /<pre style=/);
  });

  test("代码块的换行变成显式 br，不依赖平台保留 pre 空白", () => {
    const html = markdownToWechatHtml("```js\nconst a = 1;\nconst b = 2;\n```");
    assertMatch(html, /<br \/>/);
    // 换行已经被换掉，pre 里不该再留着原始换行符
    const code = html.match(/<code>([\s\S]*?)<\/code>/);
    assertTrue(code !== null, "代码块应该有 code 元素");
    assertTrue(!code![1].includes("\n"), "代码内容里不该有裸换行符");
    assertMatch(code![1], /const a = 1;<br \/>const b = 2;/);
  });

  test("代码块里的尖括号仍然是转义过的文本", () => {
    const html = markdownToWechatHtml("```\n<div>\n```");
    assertTrue(!html.includes("<div>"), "代码内容不能变成真标签");
    assertMatch(html, /&lt;div&gt;/);
  });

  test("原始 HTML 不会被原样透传", () => {
    const html = markdownToWechatHtml("<img src=x onerror=alert(1)>");
    assertTrue(!/<img[^>]*onerror/i.test(html), "原始 HTML 里的事件属性不能存活");
    assertTrue(!html.includes("<img src=x"), "原始 HTML 标签不能被原样透传");
  });

  test("style 属性里的引号被转义，属性不会提前截断", () => {
    const html = markdownToWechatHtml("正文");
    const match = html.match(/<p style="([^"]*)"/);
    assertTrue(match !== null, "段落应该有 style 属性");
    assertTrue(!match![1].includes('"'), "style 属性内部不能出现裸双引号");
  });
});

suite("排版主题与链接安全", ({ test }) => {
  test("三套主题都能渲染，彼此产出的 HTML 有实际差异", () => {
    const md = "# 标题\n\n一段正文，带**加粗**。";
    const htmls = {
      default: markdownToWechatHtml(md, { theme: "default" }),
      paper: markdownToWechatHtml(md, { theme: "paper" }),
      mist: markdownToWechatHtml(md, { theme: "mist" }),
    } as Record<ThemeId, string>;

    // 三套正文主色互不相同，说明主题真的落到配色上了，不是空转
    assertMatch(htmls.default, /color: #333333/);
    assertMatch(htmls.paper, /color: #3b3229/);
    assertMatch(htmls.mist, /color: #2c3742/);
    for (const a of Object.keys(htmls) as ThemeId[]) {
      for (const b of Object.keys(htmls) as ThemeId[]) {
        if (a !== b) assertTrue(htmls[a] !== htmls[b], `${a} 与 ${b} 应该不同`);
      }
    }
    assertEqual(Object.values(THEME_NAMES), ["深灰", "暖纸", "雾蓝"]);
  });

  test("非法主题值回退 default，合法值原样保留", () => {
    assertEqual(normalizeThemeId("mist"), "mist");
    assertEqual(normalizeThemeId("paper"), "paper");
    assertEqual(normalizeThemeId("不存在"), "default");
    assertEqual(normalizeThemeId(null), "default");
    assertEqual(normalizeThemeId(undefined), "default");
    const html = markdownToWechatHtml("正文", { theme: "不存在" as ThemeId });
    assertMatch(html, /color: #333333/);
  });

  test("标题字重降到 500，正文段落左对齐，字号与行距不变", () => {
    const html = markdownToWechatHtml("# 一级标题\n\n## 二级标题\n\n一段正文文字。");
    assertMatch(html, /<h1 style="[^"]*font-size: 22px[^"]*font-weight: 500/);
    assertMatch(html, /<h2 style="[^"]*font-weight: 500/);
    assertMatch(html, /<p style="[^"]*font-size: 16px[^"]*line-height: 1\.75[^"]*text-align: left/);
    // 加粗降到 600：得比标题的 500 重，标题和加粗才不会一样粗
    const strong = markdownToWechatHtml("这里是**加粗**。");
    assertMatch(strong, /<strong style="font-weight: 600/);
  });

  test("javascript: data: mailto: 链接一律降级成纯文本，不带 href", () => {
    for (const target of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>",
      "mailto:a@example.com",
      "/relative/path",
    ]) {
      const html = markdownToWechatHtml(`[链接文字](${target})`);
      assertTrue(!/<a\b/.test(html), `${target} 不该产出 a 标签`);
      assertTrue(!/href/.test(html), `${target} 不该留下 href`);
      assertMatch(html, /链接文字/, `${target} 的链接文字应该还在`);
    }
  });

  test("https 链接仍然产出 a 标签并保留原样式", () => {
    const html = markdownToWechatHtml("[官网](https://example.com/?a=1&b=2)");
    assertMatch(html, /<a href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
    assertMatch(html, /color: #3D7BFF/);
    assertTrue(!/text-decoration: underline/.test(html), "不该出现下划线");
  });

  test("代码块是带三圆点标题条的窗口卡片，换行仍是显式 br", () => {
    const html = markdownToWechatHtml("```ts\nconst a = 1;\nconst b = 2;\n```");
    // 三个圆点都是 12px 的实心圆
    assertEqual((html.match(/border-radius: 50%/g) ?? []).length, 3, "标题条应该有三个圆点");
    assertMatch(html, /width: 12px; height: 12px/);
    // 外层是 section，带圆角、描边和极淡阴影
    assertMatch(html, /<section style="[^"]*border-radius: 8px[^"]*box-shadow:/);
    assertMatch(html, /data-language="ts"/);
    assertMatch(html, /<pre style="[^"]*background-color: #f5f5f5/);
    const code = html.match(/<code>([\s\S]*?)<\/code>/);
    assertTrue(code !== null, "代码块应该有 code 元素");
    assertMatch(code![1], /const a = 1;<br \/>const b = 2;/);
    assertTrue(!code![1].includes("\n"), "代码内容里不该有裸换行符");
  });

  test("表格被横向滚动的 section 包住，table 自身有 min-width", () => {
    const html = markdownToWechatHtml("| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |");
    assertMatch(
      html,
      /<section style="[^"]*overflow-x: auto[^"]*max-width: 100%[^"]*"><table style="[^"]*min-width: 480px/,
    );
    // 表头样式保持不动
    assertMatch(html, /<th style="[^"]*font-weight: 700/);
  });
});

suite("Markdown 取纯文本", ({ test }) => {
  test("标记被去掉，段落之间的空行留着", () => {
    const text = markdownToPlainText("## 小标题\n\n这是一段**加粗**和`代码`的正文。\n\n第二段。");
    assertTrue(text.includes("小标题"), "标题文字要留着");
    assertTrue(text.includes("这是一段加粗和代码的正文。"), "加粗与反引号要去掉");
    assertTrue(text.includes("\n\n"), "段落之间要空一行");
    assertTrue(!text.includes("**"), "不能留着加粗标记");
    assertTrue(!text.includes("`"), "不能留着反引号");
  });

  test("列表、引用、图片的标记都去掉", () => {
    const text = markdownToPlainText("- 第一项\n- 第二项\n\n> 引用一句\n\n![图](/api/files/img/a.png)");
    assertTrue(text.includes("第一项") && text.includes("第二项"), "列表文字要留着");
    assertTrue(text.includes("引用一句"), "引用文字要留着");
    assertTrue(!text.includes("/api/files/img/a.png"), "图片地址不该进纯文本");
    assertTrue(!text.includes("- 第一项"), "列表符号要去掉");
  });

  test("空输入给空串", () => {
    assertEqual(markdownToPlainText(""), "");
    assertEqual(markdownToPlainText("   \n\n  "), "");
  });
});

suite("Markdown 取值", ({ test }) => {
  test("标题优先取第一个井号标题", () => {
    assertEqual(extractTitle("# 真正的标题\n\n正文"), "真正的标题");
    assertEqual(extractTitle("没有标题的一行\n\n第二行"), "没有标题的一行");
    assertEqual(extractTitle(""), "");
  });

  test("摘要去掉标记并按长度截断", () => {
    const summary = extractSummary("# 标题\n\n这是一段**加粗**和`代码`的正文，用来测试摘要提取。", 20);
    assertTrue(summary.length <= 21, `摘要过长：${summary.length}`);
    assertTrue(!summary.includes("**"));
    assertTrue(!summary.includes("`"));
  });

  test("取第一张图", () => {
    assertEqual(extractFirstImage("文字\n\n![alt](/api/files/img/a.png)"), "/api/files/img/a.png");
    assertEqual(extractFirstImage("没有图片"), null);
  });

  test("列出所有标题", () => {
    const headings = extractHeadings("# 一\n\n正文\n\n## 二\n\n### 三");
    assertEqual(headings.length, 3);
    assertEqual(headings[0].level, 1);
    assertEqual(headings[2].text, "三");
  });

  test("转义函数覆盖五种危险字符", () => {
    assertEqual(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  });
});
