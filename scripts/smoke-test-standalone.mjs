// 冒烟测试：在 standalone 产物里真实加载关键运行时依赖。
//
// 背景（真实踩坑）：
//   Turbopack 会把 jsdom 打成哈希目录（如 jsdom-4cccfac9827ebcfe），
//   但它对 jsdom 的间接依赖追踪不完整。产物看起来"打成功了"，
//   装到用户机器上一 require 就崩，API 返回空 body。
//   这个脚本在打包前用真实 require 验证一遍，把问题挡在构建阶段。
//
// 与 ensure-runtime-deps.mjs 的分工：
//   ensure-runtime-deps 负责补依赖（按依赖树递归复制），
//   本脚本负责验证补齐结果真的能加载——两者缺一不可。
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const standaloneDir = path.join(projectRoot, ".next", "standalone");

if (!existsSync(standaloneDir)) {
  console.error(`[smoke-test] 未找到 ${standaloneDir}，请先运行 npm run build。`);
  process.exit(1);
}

const requireFromStandalone = createRequire(path.join(standaloneDir, "server.js"));

// 每项：显示名、模块说明符、加载后的额外断言。
const CHECKS = [
  {
    name: "jsdom",
    spec: "jsdom",
    assert: (mod) => {
      const dom = new mod.JSDOM("<p>hello</p>");
      if (!dom.window.document.querySelector("p")) throw new Error("JSDOM 实例无法解析 DOM");
    },
  },
  {
    name: "tough-cookie",
    spec: "tough-cookie",
    assert: (mod) => {
      if (typeof mod.CookieJar !== "function") throw new Error("CookieJar 不可用");
    },
  },
  {
    name: "data-urls",
    spec: "data-urls",
    assert: (mod) => {
      // data-urls 的 module.exports 本身是 parse 函数，fromURLRecord 挂在它上面。
      const parse = typeof mod === "function" ? mod : mod.default;
      if (typeof parse !== "function") throw new Error("parse 不可用");
      const url = parse("data:text/plain,hello");
      if (!url || typeof url.body !== "object") throw new Error("parse 结果异常");
    },
  },
];

const failures = [];

for (const check of CHECKS) {
  try {
    const mod = requireFromStandalone(check.spec);
    check.assert(mod);
    console.log(`[smoke-test] ✓ ${check.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: check.name, message });
    console.error(`[smoke-test] ✗ ${check.name}: ${message}`);
  }
}

if (failures.length) {
  console.error("[smoke-test] standalone 产物存在无法加载的运行时依赖，打包会被中止。");
  console.error("[smoke-test] 排查方向：确认 ensure-runtime-deps.mjs 的种子包列表覆盖了出问题的包。");
  process.exit(1);
}

console.log("[smoke-test] done");
