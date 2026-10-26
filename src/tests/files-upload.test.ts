import { assertEqual, assertTrue, suite } from "./harness";
import { imageUrl, resolveImage, safeImageFileName, storeImageAs, storeImageBytes } from "../lib/files";
import { extractLocalImageRefs, localImageName } from "../lib/wechat-images";

/**
 * 素材库上传 + 正文引用图。
 *
 * 这一组对着一个具体的担心：**图插进正文后，推草稿时必须还能找到它**。
 * 公众号不接受外链图，也不认识本机地址——稿台要把正文里的
 * `/api/files/img/xxx.png` 换成微信自己的地址，换之前得先找到那个文件。
 *
 * 坑在于：正文里的地址是**百分号编码**的（中文名），磁盘上的文件名是解码后的。
 * 不解码就去找文件，永远找不到 → 图不会上传微信 → 稿子推出去图是空的。
 */
suite("素材库 · 上传与正文引用", ({ test }) => {
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
      "0d0a2db40000000049454e44ae426082",
    "hex",
  );

  test("存进去之后能按相对路径找到", async () => {
    const stored = await storeImageBytes(PNG, "shot.png");
    assertEqual(stored.path, stored.path.replace(/[\\/]/g, "/"), "路径用正斜杠");
    const found = await resolveImage(stored.path);
    assertTrue(Boolean(found), "刚存的图要能立刻找到");
  });

  test("不收不支持的格式", async () => {
    let threw = false;
    try {
      await storeImageBytes(Buffer.from("hello"), "note.txt");
    } catch {
      threw = true;
    }
    assertTrue(threw, "txt 不是图片，不该收");
  });

  test("中文名的图：正文里编码、磁盘上解码，两边要对得上", async () => {
    const name = "2026-10-24_横版_公众号知乎_三层过审流程_2000x1116.png";
    const stored = await storeImageAs(PNG, name);
    assertEqual(stored.path, name);

    // 正文里写的是编码后的地址。
    const url = imageUrl(name);
    assertTrue(url.includes("%E6%A8%AA"), "地址里应该是编码后的中文");
    const markdown = `![配图](${url})`;

    // 推草稿时：从正文里取出地址 → 解码回文件名 → 找到磁盘上的文件。
    const refs = extractLocalImageRefs(markdown);
    assertEqual(refs.length, 1, "正文里应该找得到这张图");
    assertEqual(localImageName(refs[0]), name, "解码后要还原成磁盘上的名字");
    const absolute = await resolveImage(localImageName(refs[0]));
    assertTrue(Boolean(absolute), "推草稿时要能找到这张图，否则图会丢");
  });

  test("重名不覆盖，第二个加序号", async () => {
    const first = await storeImageAs(PNG, "重复.png");
    const second = await storeImageAs(PNG, "重复.png");
    assertEqual(first.path, "重复.png");
    assertEqual(second.path, "重复-2.png");
    assertTrue(Boolean(await resolveImage(first.path)), "第一张还在");
    assertTrue(Boolean(await resolveImage(second.path)), "第二张也在");
  });
});

suite("上传文件名的清洗", ({ test }) => {
  test("原文件名要留着——那是外部生图留下的线索", () => {
    assertEqual(
      safeImageFileName("2026-10-24_横版_公众号知乎_承受得起_2000x1116.jpg"),
      "2026-10-24_横版_公众号知乎_承受得起_2000x1116.jpg",
    );
  });

  test("目录部分去掉", () => {
    assertEqual(safeImageFileName("C:\\Users\\Anyone\\配图\\封面.png"), "封面.png");
    assertEqual(safeImageFileName("/tmp/x/封面.png"), "封面.png");
  });

  test("Windows 非法字符换成下划线", () => {
    assertEqual(safeImageFileName('a<b>c:d"e|f?g*h.png'), "a_b_c_d_e_f_g_h.png");
  });

  test("全是不合法字符时给不出名字", () => {
    assertEqual(safeImageFileName(""), "");
    assertEqual(safeImageFileName("   "), "");
  });

  test("扩展名统一成小写（素材库只认这几种）", () => {
    assertEqual(safeImageFileName("图.PNG"), "图.png");
  });
});
