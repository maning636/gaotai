import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import { countHtmlTags, guessTitle, htmlToMarkdown } from "../lib/html-to-md";
import { extractExternalImageRefs, downloadExternalImage, isPrivateAddress } from "../lib/external-image";

/**
 * 导入已有文章时的 HTML 清洗。
 *
 * 这一层为什么必须有：稿台的渲染器只认 Markdown，
 * 遇到原始 HTML 会**转义成文字**（防脚本注入的必要代价）。
 * 用户从公众号后台复制来的文章直接贴，会变成一堆 `&lt;p&gt;` 字面量。
 */

suite("导入文章：HTML 洗成 Markdown", ({ test }) => {
  test("标题与段落保得住语义", () => {
    const md = htmlToMarkdown(
      "<h2>迁移复盘</h2><p>这次<strong>砍掉了两个人</strong>，代码少了<em>一半</em>。</p>",
    );
    assertMatch(md, /## 迁移复盘/);
    assertMatch(md, /\*\*砍掉了两个人\*\*/);
    assertMatch(md, /\*一半\*/);
    assertTrue(!md.includes("<p>"), "段落标签不该留下");
    assertTrue(!md.includes("&lt;"), "不该有转义出来的尖括号");
  });

  test("图片变成 Markdown 图片", () => {
    const md = htmlToMarkdown('<p>看这里</p><img src="https://x.test/a.png" alt="现场" />');
    assertMatch(md, /!\[现场\]\(https:\/\/x\.test\/a\.png\)/);
  });

  test("链接变成 Markdown 链接", () => {
    const md = htmlToMarkdown('<a href="https://x.test/p">原文在这</a>');
    assertMatch(md, /\[原文在这\]\(https:\/\/x\.test\/p\)/);
  });

  test("javascript: 链接丢掉地址，只留文字", () => {
    const md = htmlToMarkdown('<a href="javascript:alert(1)">点我</a>');
    assertTrue(!md.includes("javascript:"), "不该留下 javascript: 地址");
    assertMatch(md, /点我/);
  });

  test("脚本与样式整块丢掉", () => {
    const md = htmlToMarkdown("<style>.x{color:red}</style><p>正文</p><script>alert(1)</script>");
    assertTrue(!md.includes("alert"), "脚本不该留下");
    assertTrue(!md.includes("color:red"), "样式不该留下");
    assertMatch(md, /正文/);
  });

  test("列表变成 Markdown 列表", () => {
    const md = htmlToMarkdown("<ul><li>第一项</li><li>第二项</li></ul><ol><li>一号</li><li>二号</li></ol>");
    assertMatch(md, /- 第一项/);
    assertMatch(md, /- 第二项/);
    assertMatch(md, /1\. 一号/);
    assertMatch(md, /2\. 二号/);
  });

  test("引用与分隔线保得住", () => {
    const md = htmlToMarkdown("<blockquote>一句引用</blockquote><hr />");
    assertMatch(md, /> 一句引用/);
    assertMatch(md, /---/);
  });

  test("换行与实体处理干净", () => {
    const md = htmlToMarkdown("<p>第一行<br />第二行&nbsp;&amp;&nbsp;结束</p>");
    assertMatch(md, /第一行\n第二行/);
    assertMatch(md, /&/);
    assertTrue(!md.includes("&amp;"), "实体该解码");
    assertTrue(!md.includes("&nbsp;"), "实体该解码");
  });

  test("连着三个以上空行压成两个", () => {
    const md = htmlToMarkdown("<p>一</p><p></p><p></p><p>二</p>");
    assertTrue(!/\n{3,}/.test(md), "不该有连续三个以上换行");
  });

  test("数得出有多少 HTML 标签", () => {
    assertEqual(countHtmlTags("<p>一</p><p>二</p>"), 4);
    assertEqual(countHtmlTags("纯 Markdown 没有标签"), 0);
  });
});

suite("导入文章：标题自动猜", ({ test }) => {
  test("优先用第一个一级标题", () => {
    assertEqual(guessTitle("# 一次迁移失败的复盘\n\n正文"), "一次迁移失败的复盘");
  });

  test("没有一级标题就用第一行文字", () => {
    assertEqual(guessTitle("普通的一段开头\n\n后面还有"), "普通的一段开头");
  });

  test("空文章给个兜底", () => {
    assertEqual(guessTitle("", "未命名稿件"), "未命名稿件");
  });

  test("第一行是图片就跳过它", () => {
    assertEqual(guessTitle("![图](a.png)\n\n真正的第一句话"), "真正的第一句话");
  });
});

suite("导入文章：外链图与 SSRF 防护", ({ test }) => {
  test("只认 Markdown 图片语法里的外链，普通链接不算", () => {
    const refs = extractExternalImageRefs(
      "![图](https://a.test/x.png)\n\n[链接](https://a.test/page)\n\n![图2](https://a.test/y.png)",
    );
    assertEqual(refs.length, 2);
    assertEqual(refs[0], "https://a.test/x.png");
    assertEqual(refs[1], "https://a.test/y.png");
  });

  test("同一张外链图只算一次", () => {
    const refs = extractExternalImageRefs("![a](https://a.test/x.png)\n\n![b](https://a.test/x.png)");
    assertEqual(refs.length, 1);
  });

  test("本机地址不算外链", () => {
    assertEqual(extractExternalImageRefs("![本机](/api/files/img/a.png)").length, 0);
  });

  test("内网地址一律拦住（防 SSRF）", () => {
    // 云上的密钥接口、局域网服务、本机——都不能让稿台去下载。
    assertTrue(isPrivateAddress("127.0.0.1"), "回环");
    assertTrue(isPrivateAddress("10.1.2.3"), "A 段私网");
    assertTrue(isPrivateAddress("172.16.0.1"), "B 段私网");
    assertTrue(isPrivateAddress("172.31.255.1"), "B 段上界");
    assertTrue(isPrivateAddress("192.168.1.1"), "C 段私网");
    assertTrue(isPrivateAddress("169.254.169.254"), "链路本地（云元数据）");
    assertTrue(isPrivateAddress("100.64.0.1"), "运营商级 NAT");
    assertTrue(isPrivateAddress("0.0.0.0"), "本网络");
    assertTrue(isPrivateAddress("localhost"), "localhost");
    assertTrue(isPrivateAddress("foo.local"), ".local");
    assertTrue(isPrivateAddress("::1"), "IPv6 回环");
    assertTrue(isPrivateAddress("fd00::1"), "IPv6 唯一本地");
  });

  test("公网地址不拦", () => {
    assertTrue(!isPrivateAddress("1.1.1.1"), "公网 IPv4");
    assertTrue(!isPrivateAddress("example.com"), "公网域名");
    assertTrue(!isPrivateAddress("172.32.0.1"), "B 段之外");
    assertTrue(!isPrivateAddress("192.169.1.1"), "C 段之外");
  });

  test("内网地址下载不了", async () => {
    // 用 127.0.0.1 当源：防护必须在**发请求之前**就把它拦下来。
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof globalThis.fetch;
    try {
      let threw = false;
      try {
        await downloadExternalImage("http://127.0.0.1:3097/a.png");
      } catch {
        threw = true;
      }
      assertTrue(threw, "内网地址该被拒绝");
      assertTrue(!called, "被拒之前就不该发出请求");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("公网图片下载后落进本机素材库", async () => {
    // 用字面公网 IP 当主机：不需要 DNS，测试不依赖网络。
    const original = globalThis.fetch;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    globalThis.fetch = (async () =>
      new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } })) as typeof globalThis.fetch;
    try {
      const url = await downloadExternalImage("http://1.1.1.1/a.png");
      assertMatch(url, /^\/api\/files\/img\//);
      assertMatch(url, /\.png$/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
