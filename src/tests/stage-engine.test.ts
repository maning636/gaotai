import { assertEqual, assertTrue, suite } from "./harness";
import { buildStageMessages } from "../lib/stage-engine";
import { appendMessage, createProject, saveStageResult } from "../lib/repo";

suite("阶段引擎", ({ test }) => {
  test("系统提示按 阶段→专题→风格→前序 的顺序拼装", async () => {
    const project = createProject({ title: "编排", topicId: "general" });
    saveStageResult({ projectId: project.id, stage: "brief", content: "已确认的材料解读", status: "confirmed" });
    saveStageResult({ projectId: project.id, stage: "angle", content: "还在改的角度", status: "draft" });

    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "angle",
      userInput: "帮我挑一个方向",
      topicRules: "这是专题规则",
      topicName: "通用",
      styleProfile: "这是风格画像",
    });

    assertEqual(messages[0].role, "system");
    const system = messages[0].content;
    assertTrue(system.indexOf("这是专题规则") >= 0);
    assertTrue(system.indexOf("这是风格画像") >= 0);
    assertTrue(system.indexOf("已确认的材料解读") >= 0, "已确认的前序产出应当注入");
    assertTrue(system.indexOf("还在改的角度") < 0, "未确认的草稿不应注入");
    assertTrue(system.indexOf("这是专题规则") < system.indexOf("这是风格画像"), "专题规则应排在风格画像之前");
  });

  test("对话历史按顺序接在系统提示之后，本次输入在最后", async () => {
    const project = createProject({ title: "历史", topicId: "general" });
    appendMessage({ projectId: project.id, stage: "brief", role: "user", content: "第一句" });
    appendMessage({ projectId: project.id, stage: "brief", role: "assistant", content: "第二句" });

    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "brief",
      userInput: "第三句",
    });

    assertEqual(messages.length, 4);
    assertEqual(messages[1].content, "第一句");
    assertEqual(messages[1].role, "user");
    assertEqual(messages[2].content, "第二句");
    assertEqual(messages[2].role, "assistant");
    assertEqual(messages[3].content, "第三句");
  });

  test("别的阶段的对话不会串进来", async () => {
    const project = createProject({ title: "隔离", topicId: "general" });
    appendMessage({ projectId: project.id, stage: "article", role: "user", content: "正文阶段的话" });

    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "brief",
      userInput: "brief 阶段的话",
    });

    assertEqual(messages.length, 2);
    assertTrue(messages[1].content !== "正文阶段的话");
  });

  test("模板里的占位符不会原样发给模型", async () => {
    const project = createProject({ title: "占位", topicId: "general" });
    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "article",
      userInput: "写吧",
      topicName: "技术深读",
    });
    const system = messages[0].content;
    assertTrue(!system.includes("{{"), `系统提示里残留占位符：${system.slice(0, 200)}`);
    assertTrue(system.includes("技术深读"));
  });

  test("正文阶段不拿任何字数指令", async () => {
    // 作者 2026-10-23 的原话：「到最后你限制他输出有个屁用啊」。
    // 正文阶段的质量取决于大纲那条线和技能包的写法，
    // 提示词里塞字数只会换来「为了凑数而重复解释」。
    const project = createProject({ title: "字数", topicId: "general" });
    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "article",
      userInput: "写 2000 字左右",
    });
    const system = messages[0].content;
    assertTrue(!system.includes("2000 字"), "用户要求的字数不进正文提示词");
    assertTrue(!system.includes("{{length_target}}"), "字数指令不能留占位符");
    assertTrue(!system.includes("本次的字数目标"), "正文阶段不补字数段");
    assertTrue(!system.includes("每节的字数预算"), "正文阶段不给每节的字数账");
  });

  test("大纲阶段用已确认大纲的总字数估算当目标", async () => {
    // 总账是大纲阶段的事：它决定那几段怎么分。
    // 正文阶段不拿这个数——正文只管按线写。
    const project = createProject({ title: "总账", topicId: "general" });
    saveStageResult({
      projectId: project.id,
      stage: "outline",
      content: "## 正文大纲\n\n> 总字数估算：2200–2500 字（按各段加总）",
      status: "confirmed",
    });

    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "article",
      userInput: "照着大纲写",
    });
    const system = messages[0].content;
    assertTrue(!system.includes("2200–2500 字"), "大纲的总账不进正文提示词");
  });

  test("大纲阶段要求各段篇幅加起来对得上总账", async () => {
    const project = createProject({ title: "总账", topicId: "general" });
    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "outline",
      userInput: "写 2000 字",
    });
    const system = messages[0].content;
    assertTrue(system.includes("2000 字"), "大纲阶段要拿到字数目标");
    assertTrue(system.includes("各段"), "大纲阶段要说明各段相加");
  });

  test("中间工序各自有字数上限，正文阶段没有", async () => {
    const project = createProject({ title: "产物预算", topicId: "general" });

    const outline = await buildStageMessages({
      projectId: project.id,
      stage: "outline",
      userInput: "搭个骨架",
    });
    assertTrue(outline[0].content.includes("700 字"), "大纲产物要说明自己该有多长");
    assertTrue(outline[0].content.includes("施工图"), "大纲产物要说清是施工图不是草稿");

    const angle = await buildStageMessages({
      projectId: project.id,
      stage: "angle",
      userInput: "给几个方向",
    });
    assertTrue(angle[0].content.includes("700 字"), "选题产物要说明自己该有多长");

    const brief = await buildStageMessages({
      projectId: project.id,
      stage: "brief",
      userInput: "读一下材料",
    });
    assertTrue(brief[0].content.includes("800 字"), "材料解读要说明自己该有多长");

    const article = await buildStageMessages({
      projectId: project.id,
      stage: "article",
      userInput: "照着写",
    });
    assertTrue(
      !article[0].content.includes("这一道工序的产物该有多长"),
      "正文阶段不该收到中间工序的字数上限",
    );
  });

  test("正文阶段只拿大纲的结构和硬事实，不拿前序产出的全文", async () => {
    const project = createProject({ title: "瘦身", topicId: "general" });
    saveStageResult({
      projectId: project.id,
      stage: "brief",
      content: "## 硬事实\n\n- （材料第 3 段）行数从 800 降到 300。",
      status: "confirmed",
    });
    saveStageResult({
      projectId: project.id,
      stage: "angle",
      content: "## 角度一\n\n这个角度的论证过程写了很长一段，读起来像文章。",
      status: "confirmed",
    });
    saveStageResult({
      projectId: project.id,
      stage: "outline",
      content: [
        "## 正文大纲",
        "",
        "> **第 1 段 · 钩子**",
        "> 目的：让读者接受省的是打字时间",
        "> 内容：用同事原话开场，再补全小组数据。",
        "> 素材：材料第 4 段",
        "> 篇幅：225 字",
        "> 形式：引用 + 叙述",
        "",
        "> **第 2 段 · 展开**",
        "> 目的：把数据和原话摊开",
        "> 内容：这里写了一大段，是大纲阶段就把正文写了一遍的那种散文描述，读者不用在这里再看一遍。",
        "> 素材：材料第 5 段",
        "> 篇幅：225 字",
        "> 形式：叙述",
      ].join("\n"),
      status: "confirmed",
    });

    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "article",
      userInput: "照着写",
    });
    const system = messages[0].content;

    assertTrue(system.includes("800 降到 300"), "硬事实要进正文提示词");
    assertTrue(system.includes("钩子"), "大纲的结构要进正文提示词");
    assertTrue(
      system.indexOf("这个角度的论证过程写了很长一段") < 0,
      "选题阶段的论证过程不该进正文提示词——它已被大纲吸收，带进来只会让正文复述",
    );
    // 新大纲的「内容」是一句话交代（40 字以内），要带过去：正文照着它写才不会跑偏。
    assertTrue(
      system.indexOf("用同事原话开场，再补全小组数据。") >= 0,
      "大纲里一句话的「内容」要进正文上下文",
    );
    // 散文式的「内容」字段（超过 40 字）不该进正文上下文。
    assertTrue(
      system.indexOf("这里写了一大段，是大纲阶段就把正文写了一遍的那种散文描述") < 0,
      "大纲里散文式的「内容」字段不该进正文上下文——那是在大纲阶段就把正文写了一遍",
    );
  });

  test("技能包的写作方法由服务端注入提示词", async () => {
    const project = createProject({ title: "写作方法", topicId: "general" });
    const messages = await buildStageMessages(
      {
        projectId: project.id,
        stage: "article",
        userInput: "照着写",
      },
      { methodGuidance: "先找到说话的位置，再动笔。" },
    );
    const system = messages[0].content;
    assertTrue(system.includes("技能包里的写作方法"), "写作方法要有自己的小节");
    assertTrue(system.includes("先找到说话的位置"), "写作方法内容要进提示词");
    assertTrue(
      system.indexOf("成稿绝对不能出现") < 0,
      "技能包里的禁令清单不该再注入正文提示词——清单会让模型逐条核对，思考额度被吃光、正文一个字交不出来",
    );
  });

  test("大纲的「说话位置」带进正文提示词", async () => {
    // 枪手 skill 的方法：动笔前先找到说话位置。
    // 这四件事在大纲阶段一次想定，正文阶段直接照着这个人的口气写——
    // 挪到正文阶段想，模型每写一段都要重新想一遍「我是谁」，语气会飘，
    // 而且还要占正文阶段那点可怜的思考额度。
    const project = createProject({ title: "说话位置", topicId: "general" });
    saveStageResult({
      projectId: project.id,
      stage: "outline",
      content: [
        "**全文主张**：省下来的不是打字时间。",
        "",
        "**说话位置**",
        "- 谁在说：一个把公司代码库迁到自研编辑器的人",
        "- 凭什么知道：他迁过三次，三次都自己写的脚本",
        "- 他的判断：值不值取决于团队里有没有第二个人会写",
        "- 读者的追问：那我该按什么标准决定迁不迁",
        "",
        "## 第 1 段 · 场景",
        "推进：先把场景摆出来",
        "内容：同事第一次问能不能换个编辑器",
        "素材：材料第 2 段",
        "形式：叙述",
      ].join("\n"),
      status: "confirmed",
    });

    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "article",
      userInput: "照着写",
    });
    const system = messages[0].content;
    assertTrue(system.includes("### 谁在说话"), "说话位置要有自己的小节");
    assertTrue(system.includes("一个把公司代码库迁到自研编辑器的人"), "谁在说要带过去");
    assertTrue(system.includes("值不值取决于团队里有没有第二个人会写"), "他的判断要带过去");
    assertTrue(system.includes("那我该按什么标准决定迁不迁"), "读者的追问要带过去");
  });

  test("大纲没写说话位置时，正文退回普通作者，不硬编", async () => {
    const project = createProject({ title: "没有说话位置", topicId: "general" });
    saveStageResult({
      projectId: project.id,
      stage: "outline",
      content: [
        "## 第 1 段 · 场景",
        "推进：先把场景摆出来",
        "内容：同事来问",
        "素材：材料第 2 段",
        "形式：叙述",
      ].join("\n"),
      status: "confirmed",
    });

    const messages = await buildStageMessages({
      projectId: project.id,
      stage: "article",
      userInput: "照着写",
    });
    const system = messages[0].content;
    assertTrue(!system.includes("### 谁在说话"), "没有就别给这一节");
  });
});
