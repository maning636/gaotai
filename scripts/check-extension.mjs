// 浏览器扩展的构建期体检。
//
// 背景（真实踩坑）：
//   extension/background.js 里在非 async 回调中写了 await，
//   属于**语法错误**。Chrome 加载这个 service worker 时会直接拒绝，
//   表现是「插件装上了但永远连不上」，而界面上只会显示「未连接」——
//   用户完全无从判断是自己装错了还是插件坏了。
//   浏览器不会在安装时报错，所以必须在打包前自己检出这类问题。
//
// 检查项：
//   1. 每个 .js 都能通过 V8 语法检查（node --check 等价）；
//   2. manifest.json 能解析，且声明的文件真实存在；
//   3. content_scripts 里列出的 js 一个都不能少。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const extDir = path.join(projectRoot, "extension");

if (!existsSync(extDir)) {
  console.error(`[check-extension] 未找到 ${extDir}`);
  process.exit(1);
}

const problems = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) checkSyntax(full);
  }
}

function checkSyntax(file) {
  try {
    // node --check 与 V8 解析一致：语法错误会以非零退出码报出来。
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    const detail = String(error.stderr || error.message || "").split("\n").slice(0, 4).join(" ");
    problems.push(`语法错误：${path.relative(projectRoot, file)}\n    ${detail}`);
  }
}

walk(extDir);

// manifest 与实际文件对得上，才算「用户加载得起来」。
const manifestPath = path.join(extDir, "manifest.json");
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  problems.push(`manifest.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
}

if (manifest) {
  const required = new Set();
  const addIfString = (value) => {
    if (typeof value === "string") required.add(value);
  };
  addIfString(manifest.background?.service_worker);
  addIfString(manifest.action?.default_popup);
  for (const entry of manifest.content_scripts ?? []) {
    for (const js of entry.js ?? []) addIfString(js);
  }
  for (const file of required) {
    const full = path.join(extDir, file);
    if (!existsSync(full) || !statSync(full).isFile()) {
      problems.push(`manifest 引用了不存在的文件：${file}`);
    }
  }
}

if (problems.length) {
  console.error("[check-extension] 扩展有问题，打包中止：");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const jsCount = readdirSync(extDir, { recursive: true }).filter((f) => String(f).endsWith(".js")).length;
console.log(`[check-extension] 通过：${jsCount} 个脚本语法正常，manifest 引用的文件齐全。`);
