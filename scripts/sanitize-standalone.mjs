// 清理 Next.js standalone 产物里的敏感与无关文件。
//
// 背景：Turbopack 的文件追踪会把整个项目拉进 .next/standalone/，
// 其中包含 .env（真实密钥）、data/（个人文章库）和源码树。
// 实测 outputFileTracingExcludes 压不过 Turbopack 的追踪，
// 因此这里在打包脚本层做最后一道闸门——打包前必须执行。
//
// 白名单优先：只保留运行时真正需要的条目，其余一律清除。
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const standaloneDir = path.join(projectRoot, ".next", "standalone");

// 运行时必须保留的顶层条目。
// 提示词、公开专题与技能卡不在这里：它们由 scripts/prepare-resources.mjs
// 汇到 dist/app-resources，通过 extraResources 单独分发。
const KEEP = new Set([
  ".next", // 构建产物（server chunks 与静态资源）
  "node_modules", // 精简后的生产依赖，含原生模块二进制
  "public", // 静态资源，由 copy-standalone-assets.mjs 复制进来
  "server.js", // standalone 服务入口
  "package.json", // standalone 运行时需要的 package.json
]);

function fail(msg) {
  process.exitCode = 1;
  console.error(`[sanitize-standalone] ${msg}`);
}

if (!existsSync(standaloneDir)) {
  fail(`未找到 ${standaloneDir}。\n请先运行 "npm run build" 生成 Next.js 独立部署产物，再运行本脚本。`);
  process.exit(1);
}

// 递归计算某个路径占用的大小（字节），用于报告被清除的体积。
function dirSize(target) {
  let total = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

const removed = [];
for (const entry of readdirSync(standaloneDir, { withFileTypes: true })) {
  if (KEEP.has(entry.name)) continue;
  const full = path.join(standaloneDir, entry.name);
  const size = entry.isDirectory() ? dirSize(full) : statSync(full).size;
  rmSync(full, { recursive: true, force: true });
  removed.push({ name: entry.name, size });
}

// src/ 会被顶层白名单整块清掉，无需单独处理它的子目录。

if (removed.length) {
  console.log("[sanitize-standalone] 已清除：");
  for (const item of removed) console.log(`  - ${item.name}`);
} else {
  console.log("[sanitize-standalone] 无需清除，产物已是干净状态。");
}

const remaining = readdirSync(standaloneDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
console.log(`[sanitize-standalone] 剩余顶层目录：${remaining.join(", ")}`);

// ── 符号链接闸门 ─────────────────────────────────────────────────────────────
// standalone 里任何符号链接都会被打包器原样复制成 reparse point：
//   - 指向构建机绝对路径的链接在用户机器上悬空；
//   - 悬空链接会让 7za 压缩直接报错退出，NSIS 打包失败。
// copy-standalone-assets.mjs 会先删掉指向外部的链接；这里做兜底断言：
// 还有残留就直接让构建失败，避免产出一个装不起来的安装包。
function collectSymlinks(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      let target = "";
      try {
        target = readlinkSync(full);
      } catch {
        target = "";
      }
      out.push({ full, target });
      continue;
    }
    if (stat.isDirectory()) collectSymlinks(full, out);
  }
}

const links = [];
collectSymlinks(standaloneDir, links);
if (links.length) {
  console.error("[sanitize-standalone] 产物中仍存在符号链接，无法安全打包：");
  for (const item of links) {
    console.error(`  - ${path.relative(standaloneDir, item.full)} -> ${item.target}`);
  }
  console.error("[sanitize-standalone] 请先运行 node scripts/copy-standalone-assets.mjs 清除外部软链。");
  process.exit(1);
}

console.log("[sanitize-standalone] 无符号链接残留。");
console.log("[sanitize-standalone] done");
