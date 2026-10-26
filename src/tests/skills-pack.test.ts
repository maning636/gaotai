import { assertEqual, assertTrue, suite } from "./harness";
import { listInstalledSkills, openSkills } from "../lib/skills";
import { listTopics } from "../lib/topics";
import { extractWritingMethodSection } from "../lib/stage-engine";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 技能包契约。
 *
 * 稿台自带的写作方法（gaotai-longform）要满足几件事：
 * 1. 装得上、frontmatter 完整（name 必须等于目录名，否则技能层直接拒绝它）；
 * 2. 「怎么写」那一节能被抽出来——正文阶段注入的就是它；
 * 3. **作者的个人偏好记忆不能混进包**（文风记忆、视觉记忆是他的私人数据）；
 * 4. 引用第三方作品时留下的真实账号与链接不能留在包里；
 * 5. 专题声明的技能都真的装得上——声明了却没装，是那种没人会发现的事故。
 */
suite("技能包 · 稿台长文写作法", ({ test }) => {
  test("装得上，元信息完整", async () => {
    const installed = await listInstalledSkills();
    const ids = installed.map(skill => skill.id);
    assertTrue(ids.includes("gaotai-longform"), `技能包没装上，现有的：${ids.join(", ")}`);
    const skill = installed.find(item => item.id === "gaotai-longform")!;
    assertTrue(Boolean(skill.name), "缺 name");
    assertTrue(Boolean(skill.description), "缺 description");
    assertEqual(skill.name, "gaotai-longform", "name 必须等于目录名");
    assertTrue(skill.files.length >= 5, `文件太少：${skill.files.join(", ")}`);
  });

  test("「怎么写」那一节能被抽出来，而且不是空壳", async () => {
    const catalog = await openSkills(["gaotai-longform"]);
    const file = await catalog.read("gaotai-longform/SKILL.md");
    const section = extractWritingMethodSection(file.content);
    assertTrue(section.length > 600, `方法节太短（${section.length} 字），等于没注入`);
    // 注入的方法节要覆盖这几件事，缺一件就退化成一句「别写模板稿」。
    for (const topic of ["推进线", "前三屏", "段落", "技术", "删除"]) {
      assertTrue(section.includes(topic), `方法节里没有「${topic}」`);
    }
  });

  test("注入的方法节不能长到把额度吃光", async () => {
    const catalog = await openSkills(["gaotai-longform"]);
    const file = await catalog.read("gaotai-longform/SKILL.md");
    const section = extractWritingMethodSection(file.content);
    // 真模型实测：正文阶段一次请求的额度有限，方法节过长会挤掉正文。
    assertTrue(section.length < 4000, `方法节 ${section.length} 字，太长`);
  });

  test("作者的个人偏好记忆没有混进包", async () => {
    const installed = await listInstalledSkills();
    const skill = installed.find(item => item.id === "gaotai-longform")!;
    for (const banned of ["author-voice", "visual-preference", "author-voice-signals", "visual-preference-signals"]) {
      assertTrue(
        !skill.files.some(file => file.includes(banned)),
        `包里不该有个人偏好记忆：${banned}`,
      );
    }
  });

  test("第三方作品留下的账号与链接没有留在包里", async () => {
    const root = path.join(process.cwd(), "resources", "skills", "gaotai-longform");
    const text = readFileSync(path.join(root, "references", "micro-detail.md"), "utf8");
    assertTrue(!text.includes("@zengying1107"), "不该出现具体账号");
    assertTrue(!text.includes("@tenten19901107"), "不该出现具体账号");
    assertTrue(!text.includes("@zooYoocnan"), "不该出现具体账号");
    assertTrue(!/https?:\/\/x\.com/.test(text), "不该出现第三方链接");
    assertTrue(!text.includes("曾颖"), "不该出现具体人名");
    // 方法本身要留着
    assertTrue(text.includes("主物件"), "方法本身要保留");
  });

  test("包里带着协议与来源说明", async () => {
    const installed = await listInstalledSkills();
    const skill = installed.find(item => item.id === "gaotai-longform")!;
    assertTrue(skill.files.includes("gaotai-longform/LICENSE"), "缺 LICENSE");
    assertTrue(skill.files.includes("gaotai-longform/NOTICE"), "缺 NOTICE（来源说明）");
  });

  test("专题声明的技能都装得上", async () => {
    const topics = await listTopics();
    const installed = new Set((await listInstalledSkills()).map(skill => skill.id));
    for (const topic of topics) {
      for (const id of topic.skills ?? []) {
        assertTrue(installed.has(id), `专题 ${topic.id} 声明了没装的技能包：${id}`);
      }
    }
  });

  test("公开专题默认启用的是稿台自带的写作方法", async () => {
    const topics = await listTopics();
    for (const topic of topics) {
      assertTrue(
        (topic.skills ?? []).includes("gaotai-longform"),
        `专题 ${topic.id} 没有默认启用 gaotai-longform`,
      );
    }
  });
});
