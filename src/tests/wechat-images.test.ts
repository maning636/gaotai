import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import {
  extractLocalImageRefs,
  replaceImageRefs,
  localImageName,
  LOCAL_IMAGE_PREFIX,
} from "../lib/wechat-images";
import { imageUrl } from "../lib/files";

suite("正文图片 CDN 化", ({ test }) => {
  test("找出正文里的本机图片地址，按出现顺序且去重", () => {
    const markdown = [
      "![一](/api/files/img/a.png)",
      "正文",
      "![二](/api/files/img/sub/b.jpg)",
      "![一再来](/api/files/img/a.png)",
    ].join("\n");
    assertEqual(extractLocalImageRefs(markdown), [
      "/api/files/img/a.png",
      "/api/files/img/sub/b.jpg",
    ]);
  });

  test("外链图片不碰", () => {
    const markdown = "![远端](https://example.com/a.png)\n![本机](/api/files/img/a.png)";
    assertEqual(extractLocalImageRefs(markdown), ["/api/files/img/a.png"]);
  });

  test("没有图片时返回空数组", () => {
    assertEqual(extractLocalImageRefs("纯文字，没有图。"), []);
  });

  test("前缀常量与提取逻辑一致", () => {
    const ref = `${LOCAL_IMAGE_PREFIX}x.png`;
    assertEqual(extractLocalImageRefs(`![图](${ref})`), [ref]);
  });

  test("替换会把所有引用都换掉，包括重复出现的", () => {
    const markdown = "![一](/api/files/img/a.png)\n![一](/api/files/img/a.png)";
    const replaced = replaceImageRefs(markdown, new Map([["/api/files/img/a.png", "https://mmbiz.qpic.cn/x"]]));
    assertEqual(replaced, "![一](https://mmbiz.qpic.cn/x)\n![一](https://mmbiz.qpic.cn/x)");
  });

  test("替换不会动其它文本", () => {
    const replaced = replaceImageRefs("前面 /api/files/img/a.png 后面", new Map());
    assertEqual(replaced, "前面 /api/files/img/a.png 后面");
  });

  test("替换后的正文里不再有本机图片地址", () => {
    const markdown = "![图](/api/files/img/a.png)";
    const replaced = replaceImageRefs(markdown, new Map([["/api/files/img/a.png", "https://mmbiz.qpic.cn/x"]]));
    assertTrue(!replaced.includes("/api/files/img/"), "换完不该还剩本机地址");
    assertMatch(replaced, /https:\/\/mmbiz\.qpic\.cn\/x/);
  });
});

/**
 * 中文文件名的解码。
 *
 * 生图产物的文件名带中文（`2026-10-24_横版_公众号知乎_….jpg`），
 * 在正文里是**百分号编码**的，磁盘上是解码后的。
 * 不解码就拿地址去找文件 —— 找不到，图不会上传微信，推出去的稿子里那图是空的。
 */
suite("正文图片 · 中文文件名", ({ test }) => {
  test("地址里的编码要解回磁盘上的名字", () => {
    const name = "2026-10-24_横版_公众号知乎_三层过审流程_2000x1116.jpg";
    const url = imageUrl(name);
    assertTrue(url.includes("%E6%A8%AA"), "地址里应该是编码后的中文");
    assertEqual(localImageName(url), name);
  });

  test("ASCII 文件名解码后不变", () => {
    assertEqual(localImageName("/api/files/img/a.png"), "a.png");
  });

  test("不合法编码不炸，按原样试", () => {
    assertEqual(localImageName("/api/files/img/100%.png"), "100%.png");
  });

  test("从正文里取到的地址也能解回名字", () => {
    const name = "2026-10-24_竖版_抖音小红书_检查表_1493x2000.png";
    const url = imageUrl(name);
    const markdown = `![图](${url})`;
    const refs = extractLocalImageRefs(markdown);
    assertEqual(refs.length, 1);
    assertEqual(localImageName(refs[0]), name);
  });
});
