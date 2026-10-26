import { assertEqual, assertTrue, suite } from "./harness";
import { getPrompt, listPromptNames, renderPrompt } from "../lib/prompt-store";
import { listTopics, getTopic } from "../lib/topics";

suite("提示词仓库", ({ test }) => {
  test("七个阶段模板都在", () => {    const names = listPromptNames();
    for (const required of ["system", "brief", "angle", "outline", "article", "style-profile", "image-prompt"]) {
      assertTrue(names.includes(required), `缺少提示词：${required}`);
    }
  });

  test("每个模板都有实质内容", () => {
    for (const name of listPromptNames()) {
      assertTrue(getPrompt(name).trim().length > 200, `${name} 模板内容过短`);
    }
  });

  test("取不到的模板返回空串而不是抛错", () => {
    assertEqual(getPrompt("does-not-exist"), "");
    assertEqual(getPrompt(""), "");
  });

  test("占位符被替换", () => {
    assertEqual(renderPrompt("你好 {{name}}", { name: "稿台" }), "你好 稿台");
    assertEqual(renderPrompt("{{a}}{{b}}", { a: "1" }), "1");
  });

  test("替换只做一轮，不递归", () => {
    const result = renderPrompt("{{outer}}", { outer: "{{inner}}", inner: "不该出现" });
    assertEqual(result, "{{inner}}");
  });
});

suite("正文提示词不纠缠字数", ({ test }) => {
  test("正文模板里没有任何字数指令", () => {
    // 作者 2026-10-23 的原话：「到最后你限制他输出有个屁用啊」。
    // 正文阶段不设字数目标、不给每节的字数账、不写「篇幅」这一节。
    const article = getPrompt("article");
    assertTrue(!article.includes("{{length_target}}"), "正文模板不留字数目标的占位符");
    assertTrue(!article.includes("{{section_budget}}"), "正文模板不留每节字数账的占位符");
    assertTrue(!article.includes("## 篇幅"), "正文模板没有「篇幅」这一节");
    assertTrue(!/字数照大纲/.test(article), "不按大纲的字数写");
  });

  test("正文模板保留产品特有的操作层", () => {
    const article = getPrompt("article");
    // 说话位置是稿台自己的机制（大纲里那四行），必须在正文提示词里。
    assertTrue(article.includes("说话位置"), "正文模板要认「说话位置」");
    // 事实纪律是稿台的机制：材料里没有的不许生成。
    assertTrue(article.includes("事实纪律"), "正文模板要保留事实纪律");
    assertTrue(article.includes("需核实"), "正文模板要保留「需核实」标记");
    // 格式是操作层。
    assertTrue(article.includes("## 格式"), "正文模板要保留格式要求");
  });

  test("写作方法交给技能包，不在正文提示词里重复", () => {
    const article = getPrompt("article");
    // 这些是方法，不是操作指令：它们住在 gaotai-longform 的「怎么写」一节，
    // 正文阶段由服务端注入（见 stage-engine 的 methodGuidance）。
    assertTrue(!article.includes("三句之内要有真实的东西"), "开头方法应交给技能包");
    assertTrue(!article.includes("主导推进线"), "推进线方法应交给技能包");
    assertTrue(!article.includes("连续三段长度差不多就打破它"), "段落方法应交给技能包");
    // 但兜底要留着：技能包没加载时，正文至少还有这几条。
    assertTrue(article.includes("没有技能包时的兜底"), "要留兜底要求");
  });

  test("大纲模板要求写出「说话位置」那四行", () => {
    const outline = getPrompt("outline");
    assertTrue(outline.includes("说话位置"), "大纲模板要有说话位置");
    for (const slot of ["谁在说", "凭什么知道", "他的判断", "读者的追问"]) {
      assertTrue(outline.includes(slot), `大纲模板要写明「${slot}」`);
    }
  });
});

suite("专题体系", ({ test }) => {
  test("公开专题都加载得出来", async () => {
    const topics = await listTopics();
    assertTrue(topics.length >= 5, `公开专题至少有 5 个，实际 ${topics.length}`);
    const ids = topics.map(topic => topic.id);
    for (const required of ["general", "tech-deep-read", "industry-observer", "tool-review", "career-notes"]) {
      assertTrue(ids.includes(required), `缺少专题：${required}`);
    }
  });

  test("专题带齐元信息与规则正文", async () => {
    const topic = await getTopic("tech-deep-read");
    assertTrue(topic !== null);
    assertTrue(Boolean(topic!.name));
    assertTrue(Boolean(topic!.description));
    assertTrue(Boolean(topic!.audience));
    assertTrue(Boolean(topic!.tone));
    assertTrue(topic!.rules.length > 500, "规则正文太短，不足以约束写作");
    assertEqual(topic!.source, "public");
    assertEqual(topic!.builtin, true);
  });

  test("不同专题的规则确实不同", async () => {
    const a = await getTopic("tech-deep-read");
    const b = await getTopic("career-notes");
    assertTrue(a!.rules !== b!.rules);
  });

  test("取不存在的专题返回 null", async () => {
    assertEqual(await getTopic("nope-not-here"), null);
    assertEqual(await getTopic(""), null);
  });
});
