// 补齐 Next.js standalone 产物里「漏追踪」的运行时依赖。
//
// 背景（真实踩坑）：
//   Next 16.4.2 用 Turbopack 构建时，App Router 的路由运行时
//   `next/dist/compiled/next-server/app-route-turbo.runtime.prod.js`
//   不会被打进 .next/standalone/node_modules/next/。
//   开发机上根本看不出来——Node 解析模块时会逐级向上找 node_modules，
//   standalone 目录上面还有项目根，项目根的 node_modules/next 是完整包，
//   于是 require 成功、API 路由一切正常。
//   但装到用户机器后，standalone 上面再没有完整的 next 包，
//   require 直接抛 "Cannot find module"，
//   结果是：页面 SSR 正常（走 app-page 运行时），所有 API 路由一律 500。
//
//   也就是说，这个 bug 在开发态 100% 隐形，只在安装包里炸。
//
// 做法：不硬编码文件名，而是扫描产物里所有外部 require 的模块说明符，
//   逐个检查「在包内能否解析到实体文件」，
//   解析不到的从项目 node_modules 里补进 standalone/node_modules。
//   补的是实体文件，不依赖任何上级目录，Next 换版本也不会失效。
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const standaloneDir = path.join(projectRoot, ".next", "standalone");
const standaloneModules = path.join(standaloneDir, "node_modules");
const projectModules = path.join(projectRoot, "node_modules");

if (!existsSync(standaloneDir)) {
  console.error(`[ensure-runtime-deps] 未找到 ${standaloneDir}，请先运行 npm run build。`);
  process.exit(1);
}

// 收集产物里出现的模块说明符。
// 覆盖两种写法：CommonJS require 与动态 import()。
// 只关心「看起来像包」的说明符：相对路径、内置模块、绝对路径一律跳过。
const specRe = /(?:\brequire|\bimport)\(\s*["']([^"']+)["']\s*\)/g;
const isBuiltin = (s) => s.startsWith("node:") || builtinModules.includes(s);
const isPackageLike = (s) =>
  !s.startsWith(".") && !s.startsWith("/") && !path.isAbsolute(s) && !isBuiltin(s);

const specs = new Set();
const serverDir = path.join(standaloneDir, ".next", "server");

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    let m;
    specRe.lastIndex = 0;
    while ((m = specRe.exec(text))) {
      const spec = m[1];
      if (isPackageLike(spec)) specs.add(spec);
    }
  }
}
walk(serverDir);

// 说明符 → 包内实体路径。scope 包（@a/b）取两段，其余取一段。
function packageRootOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const copied = [];
const unresolvable = [];

for (const spec of [...specs].sort()) {
  const pkgRoot = packageRootOf(spec);
  // 只处理「包内已有这个包，但缺这个子路径」的情况——
  // 整包缺失说明 Next 的追踪完全没跟上，那是另一类问题（会在这里报出来）。
  // 查找范围覆盖两处 node_modules：standalone 根部的，以及 .next/standalone/.next 下的
  // （后者放的是 Next 为原生模块建的哈希目录，如 better-sqlite3-<hash>）。
  const candidates = [
    path.join(standaloneModules, ...spec.split("/")),
    path.join(standaloneDir, ".next", "node_modules", ...spec.split("/")),
  ];
  if (candidates.some((p) => existsSync(p))) continue;

  const inProject = path.join(projectModules, ...spec.split("/"));
  if (!existsSync(inProject)) {
    // 子路径在项目里也不存在，尝试按包解析（exports 映射等）。
    unresolvable.push(spec);
    continue;
  }

  const dest = candidates[0];
  mkdirSync(path.dirname(dest), { recursive: true });
  const st = statSync(inProject);
  if (st.isDirectory()) {
    cpSync(inProject, dest, { recursive: true, dereference: true });
  } else {
    copyFileSync(inProject, dest);
  }
  copied.push({
    spec,
    pkg: pkgRoot,
    size: st.isDirectory() ? 0 : st.size,
  });
}

if (copied.length) {
  console.log("[ensure-runtime-deps] 已补进产物的漏追踪依赖：");
  for (const item of copied) {
    console.log(`  - ${item.spec}${item.size ? ` (${(item.size / 1024).toFixed(0)} KB)` : ""}`);
  }
} else {
  console.log("[ensure-runtime-deps] 产物的外部依赖均可自解析，无需补齐。");
}

if (unresolvable.length) {
  // 这类说明符在项目里也找不到实体：要么是框架的 exports 虚拟入口，
  // 要么是真正的追踪缺口。列出清单，由人工确认，不静默放过。
  console.log("[ensure-runtime-deps] 以下说明符在项目与产物中都找不到实体文件：");
  for (const spec of unresolvable) console.log(`  ? ${spec}`);
}

// Turbopack 把 jsdom 打成哈希名（如 jsdom-4cccfac9827ebcfe），
// 它的间接依赖不会被文件追踪扫到，但运行时 require 会找到它们。
// tough-cookie 和 data-urls 是已知的两个漏网之鱼——
// 缺了它们，微信草稿渲染管线（markdownToWechatHtmlAsync → jsdom）会崩溃，
// API 返回空 body，前端报 "Unexpected end of JSON input"。
// Turbopack 把 jsdom 打成哈希名（如 jsdom-4cccfac9827ebcfe），
// 它的间接依赖不会被文件追踪扫到，但运行时 require 会找到它们。
// jsdom 的依赖链很深（tough-cookie → tldts → tldts-core，parse5 → entities，
// lru-cache → yallist，data-urls → whatwg-url → …），
// 手工维护清单永远补不全。改为递归遍历种子包的完整依赖树，
// 把所有在 standalone 里缺失的包一次性全部补进。
//
// 种子包：jsdom（微信草稿渲染核心）及其已知需要完整补齐的间接依赖。
const SEED_PACKAGES = ["jsdom", "tough-cookie", "data-urls"];
const patched = [];
const seen = new Set();

function getDependencies(pkgName) {
  try {
    const pkgJsonPath = path.join(projectModules, pkgName, "package.json");
    if (!existsSync(pkgJsonPath)) return [];
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

function ensurePackageRecursive(pkgName) {
  if (seen.has(pkgName)) return;
  seen.add(pkgName);

  const src = path.join(projectModules, pkgName);
  if (!existsSync(src)) return;

  const dst = path.join(standaloneModules, pkgName);
  // 强制复制——目录可能"存在"但不完整（只有 package.json，缺 dist/）
  cpSync(src, dst, { recursive: true, dereference: true });
  patched.push(pkgName);

  // 递归处理这个包自己的依赖
  for (const dep of getDependencies(pkgName)) {
    ensurePackageRecursive(dep);
  }
}

for (const seed of SEED_PACKAGES) {
  ensurePackageRecursive(seed);
}

if (patched.length) {
  console.log("[ensure-runtime-deps] 已补进间接依赖（Turbopack 漏追踪）：");
  for (const dep of patched) console.log(`  - ${dep}`);
}

console.log("[ensure-runtime-deps] done");
