import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import {
  builtinTemplate,
  defaultPartTemplate,
  fillTemplate,
  normalizeLayoutTemplate,
  parseLayoutPack,
  PART_CATALOG,
  renderPart,
  renderPlacement,
  sanitizeTemplateHtml,
  type LayoutTemplate,
} from "../lib/layout-template";
import { markdownToWechatHtml } from "../lib/markdown";
import { deleteTemplate, getTemplate, listTemplates, saveTemplate } from "../lib/layout-store";

/** 一段把所有元素都摆上的稿子。 */
const FULL = [
  "# 一个标题",
  "",
  "正文里有**加粗**和`行内代码`，还有[链接](https://example.com)。",
  "",
  "> 一句引用",
  "",
  "- 第一项",
  "- 第二项",
  "",
  "```js",
  "const a = 1;",
  "```",
  "",
  "| 名称 | 数值 |",
  "| --- | --- |",
  "| 甲 | 1 |",
  "",
  "---",
].join("\n");

suite("排版模板：部件模型", ({ test }) => {
  test("内置模板只有色值、没有部件覆盖", () => {
    const template = builtinTemplate("paper");
    assertEqual(template.parts.length, 0);
    assertEqual(template.vars.text, "#3b3229");
    assertEqual(template.id, "builtin:paper");
    assertEqual(template.source, "builtin");
  });

  test("三套内置模板的正文色互不相同", () => {
    const colors = (["default", "paper", "mist"] as const).map(theme => builtinTemplate(theme).vars.text);
    assertEqual(new Set(colors).size, 3);
  });

  test("部件目录覆盖到头、正文、块、尾，落位正确", () => {
    const byKey = new Map(PART_CATALOG.map(item => [item.key, item]));
    assertEqual(byKey.get("closing")?.placement, "tail");
    assertEqual(byKey.get("footer")?.placement, "tail");
    assertEqual(byKey.get("lead")?.placement, "head");
    assertEqual(byKey.get("paragraph")?.placement, "inline");
    assertEqual(byKey.get("root")?.placement, "root");
    // 每个部件都有中文名和说明，界面上才说得清它是干什么的。
    for (const meta of PART_CATALOG) {
      assertTrue(meta.name.length > 0, `${meta.key} 缺中文名`);
      assertTrue(meta.hint.length > 0, `${meta.key} 缺说明`);
    }
  });

  test("默认部件模板带内容占位，颜色走变量", () => {
    const html = defaultPartTemplate("paragraph");
    assertMatch(html, /\{\{content\}\}/);
    assertMatch(html, /\{\{text\}\}/);
    // 颜色不该写死在模板里，否则改色值就不生效了。
    assertTrue(!html.includes("#333333"), "默认模板里不该写死颜色");
  });
});

suite("排版模板：渲染", ({ test }) => {
  test("不传模板与传内置模板产出的 HTML 完全一致", () => {
    for (const theme of ["default", "paper", "mist"] as const) {
      const plain = markdownToWechatHtml(FULL, { theme });
      const viaTemplate = markdownToWechatHtml(FULL, { template: builtinTemplate(theme) });
      assertEqual(viaTemplate, plain, `${theme} 走模板与走主题应该一致`);
    }
  });

  test("模板里写了部件就用它的样式，没写的退回默认", () => {
    const template: LayoutTemplate = {
      ...builtinTemplate("default"),
      parts: [
        {
          key: "paragraph",
          name: "正文段落",
          enabled: true,
          placement: "inline",
          html: '<p class="mine" style="color: #ff0000;">{{content}}</p>',
        },
      ],
    };
    const html = markdownToWechatHtml(FULL, { template });
    assertMatch(html, /color: #ff0000/);
    assertMatch(html, /<p class="mine"/);
    // 没被覆盖的部件仍然是默认样式。
    assertMatch(html, /<blockquote style="/);
  });

  test("改一个色值，全篇跟着变", () => {
    const template: LayoutTemplate = {
      ...builtinTemplate("default"),
      vars: { ...builtinTemplate("default").vars, text: "#123456" },
    };
    const html = markdownToWechatHtml(FULL, { template });
    assertMatch(html, /color: #123456/);
    // 标题色没动，还是原来的。
    assertMatch(html, /color: #1a1a1a/);
  });

  test("开篇与结尾只在模板里写了才输出", () => {
    const bare = markdownToWechatHtml(FULL, { template: builtinTemplate("default") });
    assertTrue(!bare.includes("一段固定的开场白"), "没写开篇就不该有开篇");

    const template: LayoutTemplate = {
      ...builtinTemplate("default"),
      parts: [
        {
          key: "closing",
          name: "结尾语",
          enabled: true,
          placement: "tail",
          html: '<p style="text-align: center;">{{content}}</p>',
          text: "一段固定的结尾白",
        },
      ],
    };
    const withTail = markdownToWechatHtml(FULL, { template });
    assertMatch(withTail, /一段固定的结尾白/);
    assertTrue(
      withTail.indexOf("一段固定的结尾白") > withTail.indexOf("const a = 1;"),
      "结尾语应该排在正文后面",
    );
  });

  test("模板里的部件被关掉时退回默认样式", () => {
    const template: LayoutTemplate = {
      ...builtinTemplate("default"),
      parts: [
        {
          key: "paragraph",
          name: "正文段落",
          enabled: false,
          placement: "inline",
          html: '<p style="color: #ff0000;">{{content}}</p>',
        },
      ],
    };
    const html = markdownToWechatHtml(FULL, { template });
    assertTrue(!html.includes("#ff0000"), "关掉的部件不该生效");
    assertMatch(html, /color: #333333/);
  });

  test("正文里的占位符字样不会被当成变量替换掉", () => {
    const html = markdownToWechatHtml("正文里写了 {{text}} 和 {{content}}。", {
      template: builtinTemplate("default"),
    });
    assertMatch(html, /\{\{text\}\}/);
    assertMatch(html, /\{\{content\}\}/);
  });

  test("填模板时内容里的 $& 不会被当成替换模式", () => {
    const out = fillTemplate("<p>{{content}}</p>", {}, {}, "金额 $& 元");
    assertMatch(out, /金额 \$& 元/);
  });

  test("上下文变量压过模板变量", () => {
    const template: LayoutTemplate = {
      ...builtinTemplate("default"),
      vars: { ...builtinTemplate("default").vars, tone: "来自模板" },
      parts: [
        {
          key: "paragraph",
          name: "正文段落",
          enabled: true,
          placement: "inline",
          html: "<p>{{tone}}</p>",
        },
      ],
    };
    assertMatch(renderPart(template, "paragraph", "正文", { tone: "来自上下文" }), /来自上下文/);
    assertMatch(renderPart(template, "paragraph", "正文", {}), /来自模板/);
  });

  test("头尾部件空文本时不输出", () => {
    const template: LayoutTemplate = {
      ...builtinTemplate("default"),
      parts: [
        {
          key: "footer",
          name: "落款",
          enabled: true,
          placement: "tail",
          html: "<p>{{content}}</p>",
          text: "   ",
        },
      ],
    };
    assertEqual(renderPlacement(template, "tail"), "");
  });
});

suite("排版模板：样式包清洗", ({ test }) => {
  test("script 标签被丢掉", () => {
    const out = sanitizeTemplateHtml('<p style="color:#333">正文</p><script>alert(1)</script>');
    assertTrue(!out.toLowerCase().includes("<script"), "script 不该留下");
    assertMatch(out, /正文/);
  });

  test("事件属性被丢掉", () => {
    const out = sanitizeTemplateHtml('<p onclick="alert(1)" style="color:#333">正文</p>');
    assertTrue(!out.toLowerCase().includes("onclick"), "事件属性不该留下");
  });

  test("样式里的 url() 与 expression 被丢掉", () => {
    const out = sanitizeTemplateHtml(
      '<p style="background: url(https://evil.test/x.png); color: #333">正文</p>',
    );
    assertTrue(!out.toLowerCase().includes("url("), "url() 不该留下");
    assertMatch(out, /color: #333/);
  });

  test("样式里的引号会让属性提前截断，必须清掉", () => {
    const out = sanitizeTemplateHtml('<p style="font-family: \'x\'; color:#333">正文</p>');
    assertTrue(!/style="[^"]*"[^"]*"/.test(out), "style 属性里不该出现裸引号");
  });

  test("不在白名单里的标签丢掉标签、留下内容", () => {
    const out = sanitizeTemplateHtml("<marquee>滚动文字</marquee>");
    assertTrue(!out.includes("<marquee"), "陌生标签不该留下");
    assertMatch(out, /滚动文字/);
  });

  test("图片地址只认安全协议", () => {
    const ok = sanitizeTemplateHtml('<img src="https://example.com/a.png" alt="图" />');
    assertMatch(ok, /src="https:\/\/example\.com\/a\.png"/);
    const bad = sanitizeTemplateHtml('<img src="javascript:alert(1)" />');
    assertTrue(!bad.includes("javascript"), "javascript: 不该留下");
  });

  test("文字里的尖括号被转义，不会变成标签", () => {
    const out = sanitizeTemplateHtml("1 < 2 而 3 > 2");
    assertMatch(out, /1 &lt; 2/);
  });

  test("样式里的模板占位符要留下，不能把整条声明丢掉", () => {
    // 这一条曾经坏过：占位符带着大括号，不在样式值的白名单里，
    // 于是清洗器把整条 color 声明丢了——样式包里的部件悄悄没了样式，
    // 而且不报错。「改一个色值全篇跟着变」在导入的包里就不成立。
    const out = sanitizeTemplateHtml('<p style="color:{{text}}">正文</p>');
    assertMatch(out, /style="color: \{\{text\}\}"/);
    assertMatch(out, /正文/);
  });

  test("占位符和别的声明写在一起时，只有占位符那条被放行", () => {
    const out = sanitizeTemplateHtml('<p style="color:{{text}}; margin: 0">正文</p>');
    assertMatch(out, /color: \{\{text\}\}/);
    assertMatch(out, /margin: 0/);
  });

  test("占位符名字不合法时照样丢掉（插不进分号与引号）", () => {
    // 名字里带分号就不是占位符，整条声明按非法处理——
    // 不能只放行前半截，留一个「color: {{a」出去。
    const out = sanitizeTemplateHtml('<p style="color:{{a;b}}">正文</p>');
    assertTrue(!out.includes("{{"), "不合法的占位符不该留下");
    assertTrue(!out.includes("style="), "整条声明该被丢掉");
    assertMatch(out, /正文/);
  });

  test("标签名位置的 {{tag}} 要留着，不能当纯文本", () => {
    // 部件模板需要知道「这里放什么标签」：标题是 h1~h4、列表是 ul/ol。
    // 之前清洗器只认字母数字开头的标签名，{{tag}} 整段匹配不上标签，
    // 于是**整段 html 被转义成纯文本**——导入明明「成功」，预览里却是一堆字面量标签。
    const out = sanitizeTemplateHtml('<{{tag}} style="color:#333">{{content}}</{{tag}}>');
    assertTrue(out.includes("<{{tag}}"), "占位标签名要保住");
    assertTrue(out.includes("</{{tag}}>"), "闭合标签也要保住");
    assertTrue(!out.includes("&lt;"), "不该被转义成纯文本");
  });

  test("a 标签与它的 href 要留住", () => {
    const out = sanitizeTemplateHtml('<a href="{{href}}" style="color:#333">链接</a>');
    assertTrue(out.includes("<a "), "a 标签要留着");
    assertTrue(out.includes('href="{{href}}"'), "href 占位符要留着");
  });

  test("href 只认 http(s) 与渲染占位符", () => {
    const bad = sanitizeTemplateHtml('<a href="javascript:alert(1)">x</a>');
    assertTrue(!bad.includes("javascript"), "javascript: 不该留下");
    const good = sanitizeTemplateHtml('<a href="https://example.com">x</a>');
    assertTrue(good.includes('href="https://example.com"'), "http 链接该留着");
    const placeholder = sanitizeTemplateHtml('<a href="{{href}}">x</a>');
    assertTrue(placeholder.includes('href="{{href}}"'), "占位符该留着");
  });
});

suite("排版模板：变量与固定文本的转义", ({ test }) => {
  test("模板变量值里的引号会被转义，不会把 style 属性截断", () => {
    // 模板可能来自外部样式包，一个带引号的色值就能把属性提前截断。
    const out = fillTemplate(
      '<p style="color:{{text}}">{{content}}</p>',
      { text: '" onload="alert(1)' },
      {},
      "正文",
    );
    assertTrue(!/style="[^"]*"[^"]*"/.test(out), "style 属性里不该出现裸引号");
    assertTrue(!out.includes("onload=\"alert"), "不该拼出事件属性");
    assertMatch(out, /正文/);
  });

  test("ctx 里的值不重复转义（链接不能变成 &amp;amp;）", () => {
    const out = fillTemplate('<a href="{{href}}">{{content}}</a>', {}, { href: "https://a.test/?x=1&y=2" }, "文字");
    assertMatch(out, /href="https:\/\/a\.test\/\?x=1&y=2"/);
  });

  test("头尾部件的固定文本按纯文本处理，不会变成标签", () => {
    const template = normalizeLayoutTemplate(
      {
        name: "带固定文本",
        parts: [{ key: "closing", text: "<script>alert(1)</script>" }],
      },
      { id: "t", name: "t", source: "custom" },
    );
    const out = renderPlacement(template, "tail");
    assertTrue(!out.toLowerCase().includes("<script"), "固定文本不该变成标签");
    assertMatch(out, /&lt;script&gt;/);
  });
});

suite("排版模板：样式包导入", ({ test }) => {
  test("对象形式的部件表能解析", () => {
    const { template, warnings } = parseLayoutPack(
      JSON.stringify({
        name: "外部包",
        vars: { text: "#010203" },
        parts: {
          paragraph: { html: '<p style="color: {{text}};">{{content}}</p>' },
          closing: { html: "<p>{{content}}</p>", text: "完" },
        },
      }),
    );
    assertEqual(template.name, "外部包");
    assertEqual(template.parts.length, 2);
    assertEqual(template.vars.text, "#010203");
    assertEqual(warnings.length, 0);
  });

  test("数组形式的部件表也能解析", () => {
    const { template } = parseLayoutPack(
      JSON.stringify({
        name: "数组包",
        parts: [{ key: "quote", html: "<blockquote>{{content}}</blockquote>" }],
      }),
    );
    assertEqual(template.parts.length, 1);
    assertEqual(template.parts[0].key, "quote");
  });

  test("不认识的部件被忽略，并且说清楚", () => {
    const { template, warnings } = parseLayoutPack(
      JSON.stringify({ name: "怪包", parts: { 奇怪的部件: { html: "<p>x</p>" } } }),
    );
    assertEqual(template.parts.length, 0);
    assertTrue(warnings.length >= 1, "该有提醒");
    assertTrue(
      warnings.some(warning => warning.includes("奇怪的部件")),
      "提醒里要点名不认识的部件",
    );
  });

  test("非法 JSON 报错，不吞掉", () => {
    let threw = false;
    try {
      parseLayoutPack("{ 这不是 json");
    } catch {
      threw = true;
    }
    assertTrue(threw, "非法 JSON 应当报错");
  });

  test("导入的 html 会先清洗", () => {
    const { template } = parseLayoutPack(
      JSON.stringify({ name: "脏包", parts: { paragraph: { html: '<p onclick="x()">{{content}}</p>' } } }),
    );
    assertTrue(!template.parts[0].html.includes("onclick"), "导入时应当已经清洗过");
  });

  test("导入的部件用变量取色时，颜色真的上得去", () => {
    // 端到端：包 → 清洗 → 存成模板 → 渲染。
    // 只查「解析出来的 html 里还有没有占位符」是不够的，
    // 占位符在、但样式在清洗那一步被整条丢掉，也是白搭。
    const { template } = parseLayoutPack(
      JSON.stringify({
        name: "带色包",
        vars: { text: "#aa0000" },
        parts: { paragraph: { html: '<p style="color:{{text}}">{{content}}</p>' } },
      }),
    );
    const html = markdownToWechatHtml("一段正文。", { template });
    assertMatch(html, /color: #aa0000/);
  });

  test("规范化的模板会补齐变量、丢掉空部件", () => {
    const template = normalizeLayoutTemplate(
      { name: "补齐", vars: { text: "#111111" }, parts: [{ key: "不存在", html: "<p>x</p>" }] },
      { id: "t1" },
    );
    assertEqual(template.id, "t1");
    assertEqual(template.parts.length, 0);
    assertEqual(template.vars.text, "#111111");
    assertEqual(template.vars.heading, "#1a1a1a", "缺的变量应该用默认配色补上");
  });
});

suite("排版模板：存取", ({ test }) => {
  test("存进去的模板能读回来，部件与色值都在", () => {
    const source = builtinTemplate("mist");
    const saved = saveTemplate({
      name: "我的雾蓝",
      description: "自己改过的一套",
      template: {
        ...source,
        id: "",
        name: "我的雾蓝",
        source: "custom",
        vars: { ...source.vars, text: "#0a0a0a" },
        parts: [
          {
            key: "paragraph",
            name: "正文段落",
            enabled: true,
            placement: "inline",
            html: '<p style="color: #0a0a0a;">{{content}}</p>',
          },
        ],
      },
    });
    assertTrue(saved.id.startsWith("lay_"), "用户模板的 id 该有自己的前缀");
    const loaded = getTemplate(saved.id);
    assertTrue(loaded !== null, "存进去要读得回来");
    assertEqual(loaded!.name, "我的雾蓝");
    assertEqual(loaded!.vars.text, "#0a0a0a");
    assertEqual(loaded!.parts.length, 1);
    assertEqual(loaded!.parts[0].key, "paragraph");
  });

  test("改同一个 id 是覆盖，不是新建一份", () => {
    const first = saveTemplate({
      name: "改一次",
      template: { ...builtinTemplate("default"), id: "", name: "改一次", source: "custom" },
    });
    const second = saveTemplate({
      id: first.id,
      name: "改两次",
      template: { ...builtinTemplate("default"), id: first.id, name: "改两次", source: "custom" },
    });
    assertEqual(second.id, first.id);
    const mine = listTemplates().filter(item => item.id === first.id);
    assertEqual(mine.length, 1, "同一个 id 只该有一份");
    assertEqual(mine[0].name, "改两次");
  });

  test("模板库里既有内置的也有自己的", () => {
    const list = listTemplates();
    assertTrue(list.length >= 3, "内置三套配色应该在列表里");
    assertTrue(list.some(item => item.source === "builtin"));
  });

  test("内置模板删不掉", () => {
    assertEqual(deleteTemplate("builtin:paper"), false);
  });

  test("删掉之后就读不到了", () => {
    const saved = saveTemplate({
      name: "待删模板",
      template: { ...builtinTemplate("default"), id: "", name: "待删模板", source: "custom" },
    });
    assertEqual(deleteTemplate(saved.id), true);
    assertEqual(getTemplate(saved.id), null);
  });
});

suite("排版模板：随包分发的样式包", ({ test }) => {
  test("资源目录里的样式包都进了内置模板列表", () => {
    const packs = listTemplates().filter(item => item.id.startsWith("builtin:rico-"));
    assertTrue(packs.length >= 20, `内置样式包应该有 20 套以上，实际 ${packs.length} 套`);
  });

  test("内置样式包是只读的：能取到、删不掉", () => {
    const pack = listTemplates().find(item => item.id.startsWith("builtin:rico-"));
    assertTrue(pack !== undefined, "应该至少有一套内置样式包");
    assertEqual(getTemplate(pack!.id)?.id, pack!.id, "按 id 应该能取回同一套");
    assertEqual(deleteTemplate(pack!.id), false, "内置样式包删不掉");
  });

  test("内置样式包渲染出来没有残留占位符，也没有丢样式", () => {
    const pack = listTemplates().find(item => item.id.startsWith("builtin:rico-"));
    assertTrue(pack !== undefined);
    const html = markdownToWechatHtml("# 标题\n\n正文一段。\n\n## 小标题\n\n- 一项\n", {
      template: pack!,
    });
    assertTrue(!/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/.test(html), "渲染结果里不该有没填上的占位符");
    assertTrue(html.includes("<h1"), "标题应该渲染出来");
    assertTrue(html.includes("<h2"), "小标题应该渲染出来");
    assertMatch(html, /style="/);
  });
});
