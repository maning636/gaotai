// deps-gate 测试：验证闸门本身会抓问题（反向自测的测试）。
//
// 闸门若失灵（永远返回 OK），这里会红。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEqual, assertTrue, suite } from "./harness";
import { scanDependencyCoverage } from "../../scripts/check-deps-coverage.mjs";

function makeTempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "deps-gate-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

suite("deps-gate 反向自测", ({ test }) => {
  test("声明的依赖都被引用 → 无问题", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ dependencies: { yaml: "^2", zod: "^4" } }),
      "src/a.ts": `import YAML from "yaml";\nimport { z } from "zod";\nexport const x = YAML + z;\n`,
    });
    try {
      const r = scanDependencyCoverage(dir);
      assertEqual(r.problems.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("未声明的第三方 import → 报缺失（闸门核心能力）", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "src/a.ts": `import { fromMarkdown } from "mdast-util-from-markdown";\nexport { fromMarkdown };\n`,
    });
    try {
      const r = scanDependencyCoverage(dir);
      assertTrue(r.problems.some((p) => p.kind === "undeclared" && p.spec === "mdast-util-from-markdown"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("声明了但零引用 → 报冗余", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ dependencies: { cheerio: "^1" } }),
      "src/a.ts": `export const x = 1;\n`,
    });
    try {
      const r = scanDependencyCoverage(dir);
      assertTrue(r.problems.some((p) => p.kind === "unused" && p.spec === "cheerio"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Node 内置模块与相对导入不算第三方", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "src/a.ts": `import { readFileSync } from "node:fs";\nimport { helper } from "./helper";\nexport { readFileSync, helper };\n`,
      "src/helper.ts": `export const helper = 1;\n`,
    });
    try {
      const r = scanDependencyCoverage(dir);
      assertEqual(r.problems.filter((p) => p.kind === "undeclared").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("import type 也算引用（@types/mdast 场景）", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ devDependencies: { "@types/mdast": "^4" } }),
      "src/a.ts": `import type { Root } from "mdast";\nexport type R = Root;\n`,
    });
    try {
      const r = scanDependencyCoverage(dir);
      // mdast 由 @types/mdast 提供类型；未声明 mdast 运行时包不算缺失，
      // 因为纯类型引用不需要运行时实体。
      const undeclared = r.problems.filter((p) => p.kind === "undeclared");
      assertEqual(undeclared.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("子路径导入按包名对齐（zod/v4 → zod）", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ dependencies: { zod: "^4" } }),
      "src/a.ts": `import { z } from "zod/v4";\nexport { z };\n`,
    });
    try {
      const r = scanDependencyCoverage(dir);
      assertEqual(r.problems.filter((p) => p.kind === "undeclared").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("require 也算引用（scripts/*.mjs）", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ dependencies: { yaml: "^2" } }),
      "scripts/x.mjs": `const YAML = require("yaml");\nexport default YAML;\n`,
    });
    try {
      const r = scanDependencyCoverage(dir);
      assertEqual(r.problems.filter((p) => p.kind === "undeclared").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
