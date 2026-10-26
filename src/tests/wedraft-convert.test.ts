import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import { parseLayoutPack, type LayoutPartKey } from "../lib/layout-template";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** 随包资源目录的绝对路径（测试从 src/tests 出发）。 */
const PACKS_DIR = path.resolve(__dirname, "../../resources/layout-packs");

/**
 * 7 套 WeDraft 排版模板：id → 上游 accentColor。
 *
 * 素笺/墨刊/青岚/蓝图/朱砂 是 reading-editions.ts 里 createEdition 的 accent 参数；
 * 小哈公社 与小哈公社New 是 JSON 模板，无显式 accentColor，稿台以 heading2.color 作代表色。
 */
const EXPECTED_ACCENTS: Record<string, string> = {
  "wedraft-plain-paper": "#756655",
  "wedraft-ink-journal": "#272727",
  "wedraft-jade-notes": "#27675C",
  "wedraft-blueprint": "#2857B7",
  "wedraft-cinnabar": "#A3453C",
  "wedraft-default-business": "#FFA900",
  "wedraft-next-edition": "#FFA900",
};

/** 每套必须有的关键部件（正文排版的最小组合）。 */
const REQUIRED_PARTS: LayoutPartKey[] = ["root", "heading", "paragraph", "quote", "list", "code", "table"];

function loadPack(slug: string) {
  const file = path.join(PACKS_DIR, `${slug}.json`);
  const text = readFileSync(file, "utf8");
  return parseLayoutPack(text, slug);
}

suite("WeDraft 排版模板：转换产物", ({ test }) => {
  test("7 套模板全部生成", () => {
    const files = readdirSync(PACKS_DIR).filter(f => f.startsWith("wedraft-") && f.endsWith(".json"));
    assertEqual(files.length, 7, `应恰好 7 套 wedraft 包，实际 ${files.length}: ${files.join(", ")}`);
  });

  test("7 套模板 parseLayoutPack 0 warnings", () => {
    for (const slug of Object.keys(EXPECTED_ACCENTS)) {
      const { warnings } = loadPack(slug);
      assertEqual(warnings.length, 0, `${slug}：${warnings.join("; ")}`);
    }
  });

  test("每套 accent 与源模板一致", () => {
    for (const [slug, expected] of Object.entries(EXPECTED_ACCENTS)) {
      const { template } = loadPack(slug);
      assertEqual(template.vars.accent, expected, `${slug} accent 不匹配`);
    }
  });

  test("每套关键部件齐全", () => {
    for (const slug of Object.keys(EXPECTED_ACCENTS)) {
      const { template } = loadPack(slug);
      const keys = new Set(template.parts.map(p => p.key));
      for (const part of REQUIRED_PARTS) {
        assertTrue(keys.has(part), `${slug} 缺少关键部件 ${part}`);
      }
    }
  });

  test("name 与 description 带上 WeDraft 出处", () => {
    for (const slug of Object.keys(EXPECTED_ACCENTS)) {
      const { template } = loadPack(slug);
      assertMatch(template.name, /^WeDraft · /, `${slug} name 应带「WeDraft · 」前缀`);
      assertTrue(
        template.description.includes("WeDraft") && template.description.includes("MIT"),
        `${slug} description 应提到 WeDraft 与 MIT，实际：${template.description}`,
      );
    }
  });

  test("素笺关键色断言", () => {
    const { template } = loadPack("wedraft-plain-paper");
    assertEqual(template.vars.accent, "#756655");
    assertEqual(template.vars.text, "#3F3D39");
    assertEqual(template.vars.heading, "#3F3D39");
    assertEqual(template.vars.muted, "#74706A");
    assertEqual(template.vars.border, "#E6E0D7");
    assertEqual(template.vars.surface, "#F8F6F1");
    assertEqual(template.vars.codeBg, "#FAF9F6");
    assertEqual(template.vars.codeText, "#3F3D39");
  });

  test("蓝图关键色断言", () => {
    const { template } = loadPack("wedraft-blueprint");
    assertEqual(template.vars.accent, "#2857B7");
    assertEqual(template.vars.text, "#3B424D");
    assertEqual(template.vars.heading, "#2F3540");
    assertEqual(template.vars.muted, "#6D7684");
    assertEqual(template.vars.border, "#DFE6F1");
    assertEqual(template.vars.surface, "#F1F5FC");
    assertEqual(template.vars.codeBg, "#F6F8FC");
    assertEqual(template.vars.codeText, "#3B424D");
  });

  test("HTML 里的色值走变量占位符，不写死", () => {
    // 「改一个色值全篇跟着变」在导入包里也成立的前提。
    // 正文段落与标题的 color 必须是 {{text}} / {{heading}}，不能是 hex。
    const { template } = loadPack("wedraft-blueprint");
    const byKey = new Map(template.parts.map(p => [p.key, p.html]));
    assertTrue(byKey.get("paragraph")!.includes("color: {{text}}"), "paragraph 应用 {{text}}");
    assertTrue(byKey.get("heading")!.includes("color: {{heading}}"), "heading 应用 {{heading}}");
    assertTrue(byKey.get("link")!.includes("color: {{accent}}"), "link 应用 {{accent}}");
    assertTrue(byKey.get("code")!.includes("background-color: {{codeBg}}"), "code 应带 {{codeBg}}");
  });

  test("许可文件齐全", () => {
    assertTrue(existsSync(path.join(PACKS_DIR, "LICENSE-wedraft")), "缺 LICENSE-wedraft");
    assertTrue(existsSync(path.join(PACKS_DIR, "SOURCE-wedraft.json")), "缺 SOURCE-wedraft.json");
    const license = readFileSync(path.join(PACKS_DIR, "LICENSE-wedraft"), "utf8");
    assertTrue(license.includes("Copyright (c) 2026 pafa and WeDraft contributors"), "LICENSE 应有 pafa 版权行");
    const source = JSON.parse(readFileSync(path.join(PACKS_DIR, "SOURCE-wedraft.json"), "utf8"));
    assertEqual(source.upstream, "github.com/pafa/WeDraft");
    assertEqual(source.license, "MIT");
    assertTrue(Array.isArray(source.included) && source.included.length === 7, "SOURCE 应列出 7 套");
  });
});
