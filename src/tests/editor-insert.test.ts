import { assertEqual, assertTrue, suite } from "./harness";
import { insertMarkdownAt } from "../lib/editor-insert";

suite("正文插图位置", ({ test }) => {
  test("没有光标位置时插到末尾", () => {
    const { content, caret } = insertMarkdownAt("第一段。\n\n第二段。", null, "![图](url)");
    assertTrue(content.endsWith("![图](url)\n"), "应插在末尾");
    assertEqual(caret, content.length - 1);
  });

  test("光标在中间时插在中间", () => {
    const base = "# 标题\n\n第一段。\n\n第二段。";
    const position = base.indexOf("第二段");
    const { content } = insertMarkdownAt(base, position, "![图](url)");
    const imgAt = content.indexOf("![图](url)");
    assertTrue(imgAt > content.indexOf("第一段") && imgAt < content.indexOf("第二段"), "图应落在两段之间");
  });

  test("光标在开头时插在开头", () => {
    const { content } = insertMarkdownAt("正文。", 0, "![图](url)");
    assertTrue(content.startsWith("![图](url)"), "应插在最前面");
  });

  test("位置超出长度时按末尾处理", () => {
    const { content } = insertMarkdownAt("正文。", 999, "![图](url)");
    assertTrue(content.indexOf("![图](url)") > content.indexOf("正文"), "图应在正文之后");
  });

  test("用换行隔开，不会和老段落粘成一行", () => {
    const { content } = insertMarkdownAt("第一段。", 4, "![图](url)");
    assertTrue(content.includes("第一段。\n\n![图](url)"), "前后要空行");
  });
});
