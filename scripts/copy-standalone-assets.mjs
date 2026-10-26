// 补齐 Next.js output:"standalone" 遗漏的两类静态资源：
//   - public/**           静态资源（favicon、manifest 等）
//   - .next/static/**     客户端 JS/CSS chunk、字体等
// 若缺失，前端页面加载会大面积 404（样式丢失、脚本 500）。
// standalone 目录不存在时给出可读错误，方便用户定位「先跑 npm run build」。
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const standaloneDir = path.join(projectRoot, ".next", "standalone");

function fail(msg) {
  // 用 process.exitCode 而不是 throw，让输出更友好、不产生堆栈。
  process.exitCode = 1;
  console.error(`[copy-standalone-assets] ${msg}`);
}

if (!existsSync(standaloneDir)) {
  fail(`未找到 ${standaloneDir}。\n请先运行 "npm run build" 生成 Next.js 独立部署产物，再运行本脚本。`);
  process.exit(1);
}

// ── 第一步：补齐静态资源 ─────────────────────────────────────────────────────
// output:"standalone" 不含 public/ 与 .next/static/，必须手工补齐，否则页面 404。
const jobs = [
  { from: "public", to: "public" },
  { from: ".next/static", to: ".next/static" },
];

for (const job of jobs) {
  const src = path.join(projectRoot, job.from);
  const dest = path.join(standaloneDir, job.to);

  if (!existsSync(src)) {
    // public/ 不是必需的（没有静态资源时页面照样工作），缺失只当提醒。
    // 早期版本在这里调 fail()，把 exitCode 置成 1，导致 npm 的 && 链在这里断掉，
    // 后面的资源准备与打包根本没执行，产物里少了 resources。
    console.warn(`[copy-standalone-assets] 源目录不存在，跳过：${job.from}`);
    mkdirSync(dest, { recursive: true });
    continue;
  }

  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-standalone-assets] copy ${job.from} -> ${path.relative(projectRoot, dest)}`);
}

// ── 第二步：清理 standalone 里不该存在的条目（安全闸门）─────────────────────
//
// 为什么必须在这里做：
//   Turbopack 的文件追踪会把整个项目（.env、data/、src/、README.md 等）都塞进
//   standalone 产物。next.config.ts 的 outputFileTracingExcludes 已经实测压不过
//   Turbopack，所以必须在打包脚本这一层做最后一道闸门。
//
// .env 尤其致命：里面装着 DEEPSEEK_API_KEY、公众号 AppSecret、SESSION_SECRET，
// 一旦随安装包分发给 Windows 用户就等于把密钥公开。
//
// 策略：白名单优先。列出必须保留的顶层条目，其余全部删除。
// 白名单：
//   server.js          Next standalone 入口
//   package.json       模块解析必需（Next 用它识别依赖）
//   .next/             Next 内部静态产物
//   node_modules/      standalone 自带的最小依赖树（含 better-sqlite3/canvas 原生模块）
//   public/            第一步刚补进去的
//   src/lib/prompts/   运行时提示词资源（src/ 只保留这个子树，src/ 顶层其余全清）
//   topics/            公开示例专题
//   .agents/           写作技能
//
// 稿台不需要保留 src/topics/.agents：提示词、公开专题与技能卡改由
// scripts/prepare-resources.mjs 汇到 dist/app-resources，
// 再通过 extraResources 分发、由 GAOTAI_RESOURCE_DIR 指向。
// 保留它们只会在安装包里多出一份副本，还让人误以为有两个来源。
const KEEP_TOP = new Set([
  "server.js",
  "package.json",
  ".next",
  "node_modules",
  "public",
]);

function listEntries(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

console.log("[copy-standalone-assets] sanitize (before):", listEntries(standaloneDir).join(", "));

// 1) 顶层白名单清理：不在 KEEP_TOP 的、以及任何 .env* 一律删除。
for (const entry of listEntries(standaloneDir)) {
  // .env / .env.example / .env.production 等 —— 密钥文件，最高优先级清掉。
  if (/^\.env(\.|$)/.test(entry)) {
    rmSync(path.join(standaloneDir, entry), { recursive: true, force: true });
    console.log(`[copy-standalone-assets] removed .env*: ${entry}`);
    continue;
  }
  if (KEEP_TOP.has(entry)) continue;
  rmSync(path.join(standaloneDir, entry), { recursive: true, force: true });
  console.log(`[copy-standalone-assets] removed top: ${entry}`);
}

// 2) src/ 已经被顶层白名单整块清掉，这里无需再单独处理它的子目录。

console.log("[copy-standalone-assets] sanitize (after): ", listEntries(standaloneDir).join(", "));

// ── 第三步：把指向构建机的外部软链换成包内转发垫片 ─────────────────────────
//
// Next 的 standalone 追踪会给原生模块建带哈希的软链，例如：
//   .next/standalone/.next/node_modules/better-sqlite3-<hash>
//     -> D:\某个构建目录\node_modules\better-sqlite3
// 编译后的 chunk 里写死了 require("better-sqlite3-<hash>")，运行时靠这个目录名解析，
// 所以目录名必须保留。但目标是**构建机上的绝对路径**：装到用户机器后必然悬空，
// 而且 electron-builder 解包 + 7za 压缩时会因悬空链接直接报错退出，NSIS 步骤失败。
//
// 处理办法：删掉软链，在原位置建一个同名目录，用一个极小的转发垫片指回
// standalone 自带的真实包（.next/standalone/node_modules/<包名>）。
//   - 目录名保持不变 → chunk 里的 require 照常解析；
//   - 真实包已在 standalone 内 → 不复制 DLL/.node，不增加安装包体积；
//   - 全部是真实文件 → 打包器、7za、用户机器都不会再遇到软链问题。
// 万一 standalone 里找不到对应真实包，退化为直接复制整个包目录，保证功能不缺。
//
// 注意：不区分「指向外部」和「指向内部」。指向内部的软链同样要换掉——
// 打包器会把软链原样复制成 reparse point，Windows 上既是权限噪音，
// 也是 7za 压缩的报错来源；而且软链目标在 asar 里是虚拟路径，运行时未必解析得动。
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
      let target;
      try {
        target = readlinkSync(full);
      } catch {
        target = "";
      }
      // Windows 的 readlink 会返回 \\?\ 前缀的绝对路径，去掉它更便于后续 fs 调用。
      const rawTarget = target.replace(/^\\\\\?\\/, "");
      const resolved = path.resolve(path.dirname(full), rawTarget);
      out.push({ full, target, resolved });
      continue;
    }
    if (stat.isDirectory()) collectSymlinks(full, out);
  }
}

// 读取包名：以目标目录的 package.json 为准，取不到则退回目录名。
function packageNameOf(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg && typeof pkg.name === "string" && pkg.name) return pkg.name;
  } catch {
    /* 读不到就退回目录名 */
  }
  return path.basename(dir);
}

const links = [];
collectSymlinks(standaloneDir, links);

for (const item of links) {
  const hashedName = path.basename(item.full);

  // 软链指向的是文件而不是目录：直接复制内容，保留原名。
  let targetIsDir;
  try {
    targetIsDir = statSync(item.resolved).isDirectory();
  } catch {
    targetIsDir = false;
  }
  if (!targetIsDir) {
    rmSync(item.full, { force: true });
    try {
      cpSync(item.resolved, item.full);
      console.log(`[copy-standalone-assets] replaced symlink (file copy): ${hashedName}`);
    } catch {
      console.warn(`[copy-standalone-assets] 无法替换软链（目标不可读）：${hashedName}`);
    }
    continue;
  }

  const realName = packageNameOf(item.resolved);
  // standalone 自带的真实包（Next 已经把被追踪的文件复制进来了）。
  const realCopy = path.join(standaloneDir, "node_modules", ...realName.split("/"));
  const realVersion = (() => {
    try {
      return JSON.parse(readFileSync(path.join(realCopy, "package.json"), "utf8")).version || "0.0.0";
    } catch {
      return "0.0.0";
    }
  })();

  // rmSync 对符号链接执行 unlink，不会顺着链接删到目标目录。
  rmSync(item.full, { recursive: true, force: true });

  if (!existsSync(realCopy)) {
    // 退化路径：standalone 里没有真实包，直接整份复制，保证不缺功能。
    cpSync(item.resolved, item.full, { recursive: true, dereference: true });
    console.log(`[copy-standalone-assets] replaced symlink (copied): ${hashedName}`);
    continue;
  }

  mkdirSync(item.full, { recursive: true });
  // 相对路径要以垫片自身目录（item.full）为基准：require 从 index.js 所在目录解析。
  const rel = path.relative(item.full, realCopy).split(path.sep).join("/");
  writeFileSync(
    path.join(item.full, "package.json"),
    `${JSON.stringify({ name: hashedName, version: realVersion, main: "index.js" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(item.full, "index.js"),
    [
      "// 转发到 standalone 自带的真实包（Next 的追踪软链指向构建机路径，装机后必然悬空）。",
      "// 目录名保持 chunk 里写死的哈希 id 不变，require 才能解析到。",
      `module.exports = require("${rel}");`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`[copy-standalone-assets] replaced symlink (shim): ${hashedName} -> ${rel}`);
}

if (!links.length) {
  console.log("[copy-standalone-assets] 无符号链接需要处理。");
}

console.log("[copy-standalone-assets] done");
