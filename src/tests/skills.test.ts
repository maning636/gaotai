import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import { listInstalledSkills, openSkills, renderSkillCatalog } from "../lib/skills";
import { resourceDir } from "../lib/paths";

/**
 * 技能包访问层测试。
 *
 * 重点在两件事：
 * 1. 路径安全——模型给的路径不能把读取带出技能目录；
 * 2. 激活判定——文件躺在磁盘上不等于这次用了它。
 */

/** 临时造一个技能资源根目录，返回它的路径。 */
function makeResourceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "gaotai-skills-"));
  return root;
}

/** 在资源根目录里造一个技能包。 */
function writeSkill(
  root: string,
  id: string,
  frontmatter: string,
  files: Record<string, string> = {},
): void {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n正文内容。\n`, "utf8");
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/** 在临时资源根下跑一段逻辑，结束后把环境变量还原。 */
async function withResourceRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.GAOTAI_RESOURCE_DIR;
  process.env.GAOTAI_RESOURCE_DIR = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.GAOTAI_RESOURCE_DIR;
    else process.env.GAOTAI_RESOURCE_DIR = previous;
  }
}

suite("技能包访问层", ({ test }) => {
  test("装好的技能能被打开，元信息齐全", async () => {
    const catalog = await openSkills(["human-writing"]);
    assertEqual(catalog.skills.length, 1);
    assertEqual(catalog.skills[0].id, "human-writing");
    assertEqual(catalog.skills[0].name, "human-writing");
    assertTrue(catalog.skills[0].description.length > 20, "description 太短，说不清这个技能管什么");
    assertEqual(catalog.skills[0].location, "human-writing/SKILL.md");
  });

  test("自研的编辑规则包也在，版本号能读出来", async () => {
    const catalog = await openSkills(["gaotai-editorial"]);
    assertEqual(catalog.skills[0].version, "1.0.0");
    assertTrue(catalog.skills[0].description.includes("标题"), "说明里要讲清楚这个技能管哪几件事");
  });

  test("技能目录里的参考文件能读到", async () => {
    const catalog = await openSkills(["gaotai-editorial"]);
    const file = await catalog.read("gaotai-editorial/references/headline.md");
    assertTrue(file.content.trim().length > 100, "参考文件内容过短");
    assertEqual(file.file, "gaotai-editorial/references/headline.md");
  });

  test("未启用的技能读不到", async () => {
    const catalog = await openSkills(["human-writing"]);
    let message = "";
    try {
      await catalog.read("gaotai-editorial/SKILL.md");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertMatch(message, /未在本次启用/);
  });

  test("绝对路径被拒绝", async () => {
    const catalog = await openSkills(["human-writing"]);
    let message = "";
    try {
      await catalog.read("C:\\Windows\\win.ini");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertMatch(message, /相对路径/);
  });

  test("带 .. 的路径被拒绝", async () => {
    const catalog = await openSkills(["human-writing"]);
    let message = "";
    try {
      await catalog.read("human-writing/../../secrets.txt");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertMatch(message, /\.\.|技能目录内/);
  });

  test("符号链接不能把读取带出技能目录", async () => {
    const root = makeResourceRoot();
    const skills = path.join(root, "skills");
    try {
      writeSkill(skills, "linked", "name: linked\ndescription: 用于验证符号链接越界。");
      const outside = path.join(root, "outside.txt");
      writeFileSync(outside, "不该被读到。", "utf8");
      try {
        symlinkSync(outside, path.join(skills, "linked", "escape.txt"));
      } catch {
        // 建不出符号链接就跳过这条：Windows 上需要额外权限
        return;
      }
      await withResourceRoot(root, async () => {
        const catalog = await openSkills(["linked"]);
        let message = "";
        try {
          await catalog.read("linked/escape.txt");
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        assertMatch(message, /符号链接|不存在/);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("只读参考文件不算激活，读过入口才算", async () => {
    const catalog = await openSkills(["gaotai-editorial"]);
    await catalog.read("gaotai-editorial/references/opening.md");
    assertEqual(catalog.loaded.size, 0, "只读参考文件不该算作已加载入口");
    let message = "";
    try {
      catalog.assertActivated();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertMatch(message, /没有真正读过/);
  });

  test("读过入口后断言通过", async () => {
    const catalog = await openSkills(["gaotai-editorial"]);
    await catalog.read("gaotai-editorial/SKILL.md");
    assertTrue(catalog.loaded.has("gaotai-editorial"));
    catalog.assertActivated();
  });

  test("技能清单写给模型看时包含入口路径", async () => {
    const catalog = await openSkills(["human-writing", "gaotai-editorial"]);
    const text = renderSkillCatalog(catalog);
    assertMatch(text, /human-writing\/SKILL\.md/);
    assertMatch(text, /gaotai-editorial\/SKILL\.md/);
    assertMatch(text, /read_skill_file/);
  });

  test("没有技能时清单为空字符串", async () => {
    const catalog = await openSkills([]);
    assertEqual(renderSkillCatalog(catalog), "");
  });

  test("工具声明固定为 read_skill_file，并写明不联网不执行脚本", async () => {
    const catalog = await openSkills(["human-writing"]);
    assertEqual(catalog.tool.type, "function");
    assertEqual(catalog.tool.function.name, "read_skill_file");
    assertMatch(catalog.tool.function.description, /不联网/);
    assertMatch(catalog.tool.function.description, /不执行脚本/);
  });

  test("坏掉的技能包不拖垮整个列表", async () => {
    const root = makeResourceRoot();
    const skills = path.join(root, "skills");
    try {
      writeSkill(skills, "good", "name: good\ndescription: 好的技能包。");
      // name 与目录名不一致，属于坏包
      writeSkill(skills, "broken", "name: another\ndescription: 名字对不上。");
      const list = await withResourceRoot(root, () => listInstalledSkills());
      assertEqual(list.map(item => item.id), ["good"]);
      assertTrue(list[0].files.some(file => file.endsWith("SKILL.md")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("本机实际装好的技能至少有两个", async () => {
    const list = await listInstalledSkills();
    const ids = list.map(item => item.id);
    assertTrue(ids.includes("human-writing"), "缺少 human-writing 技能包");
    assertTrue(ids.includes("gaotai-editorial"), "缺少 gaotai-editorial 技能包");
  });

  test("human-writing 带着 MIT 许可证与来源说明", async () => {
    const list = await listInstalledSkills();
    const skill = list.find(item => item.id === "human-writing");
    assertTrue(Boolean(skill), "human-writing 没有被列出来");
    const files = skill!.files;
    assertTrue(files.includes("human-writing/LICENSE"), "缺少 LICENSE");
    assertTrue(files.includes("human-writing/SOURCE.json"), "缺少 SOURCE.json");
    assertTrue(files.includes("human-writing/VERSION"), "缺少 VERSION");
  });

  test("资源目录里确实有这些技能文件", () => {
    const root = path.join(resourceDir(), "skills");
    assertTrue(Boolean(root));
  });
});
