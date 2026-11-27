// 发布前最后一道门：确认安装包里没有开发机的私货。
//
// 为什么要有这一步：`files` 白名单里包含 `.next/standalone/**`，而 Next 的 standalone
// 产物会把项目根的 .env 一起复制进去；再叠加 electron-builder 对空目录的处理，
// 「密钥混进安装包」这种事只要发生过一次，就是把自己和用户的账号一起送出去。
// 靠人肉检查迟早漏，所以让构建直接失败。
//
// 检查对象：release/win-unpacked（安装包与便携版都由它生成）。
// 可用参数覆盖：node scripts/verify-package.mjs release-new
// 构建时用 -c.directories.output=别的目录 时，这里也要跟着指过去，
// 否则会扫描残留的旧产物、得出"通过"的假结论。
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUTPUT_DIR = process.argv[2]?.trim() || "release";
const APP_DIR = path.join(ROOT, OUTPUT_DIR, "win-unpacked");

/** 任何位置出现都算事故（必须带值，空模板另说）。 */
const FATAL_ANYWHERE = [
  { test: p => /(^|[\\/])\.env(\.(local|production|development|test))?$/.test(p), why: "环境变量文件（含密钥）" },
  { test: p => /(^|[\\/])\.license([\\/]|$)/.test(p), why: "授权令牌缓存" },
  { test: p => /(^|[\\/])initial-password\.txt$/.test(p), why: "首次启动生成的登录口令" },
  { test: p => /\.sqlite(-wal|-shm)?$/.test(p), why: "本地数据库（含公众号配置与稿件）" },
];

/** 只在业务目录里判断（node_modules 里可能有同名的包文件，误报会挡住正常打包）。 */
const FATAL_OUTSIDE_DEPS = [
  { test: p => /(^|[\\/])agent-config\.json$/.test(p), why: "模型配置（含 API Key）" },
  { test: p => /(^|[\\/])login-failures\.jsonl$/.test(p), why: "登录失败日志" },
  { test: p => /(^|[\\/])token\.json$/.test(p), why: "授权令牌" },
];

/** 这四类资产由服务器下发，打进安装包等于把技能包直接送人。 */
const MUST_NOT_SHIP_ASSETS = ["skills", "prompts", "topics", "layout-packs"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push({ full, dir: true });
    else out.push({ full, dir: false });
    if (st.isDirectory()) walk(full, out);
  }
  return out;
}

function main() {
  if (!existsSync(APP_DIR)) {
    console.error("[verify-package] 找不到 ${OUTPUT_DIR}/win-unpacked，先跑一次 desktop:build。");
    process.exit(1);
  }

  const entries = walk(APP_DIR);
  const problems = [];

  for (const entry of entries) {
    const rel = path.relative(APP_DIR, entry.full).split(path.sep).join("/");
    const inDeps = rel.includes("node_modules/");
    for (const rule of FATAL_ANYWHERE) {
      if (rule.test(entry.full)) problems.push(`${rule.why}：${rel}`);
    }
    if (!inDeps) {
      for (const rule of FATAL_OUTSIDE_DEPS) {
        if (rule.test(entry.full)) problems.push(`${rule.why}：${rel}`);
      }
    }
  }

  const resourceDir = path.join(APP_DIR, "resources");
  const requiredLicenseFiles = [
    "LICENSE",
    "NOTICE.txt",
    "SOURCE.txt",
    "THIRD_PARTY_LICENSES/GPL-3.0.txt",
    "THIRD_PARTY_LICENSES/human-writing-MIT.txt",
    "THIRD_PARTY_LICENSES/rico-md-MIT.txt",
    "THIRD_PARTY_LICENSES/WeDraft-MIT.txt",
    "THIRD_PARTY_LICENSES/gaotai-longform-MIT.txt",
  ];
  for (const relativePath of requiredLicenseFiles) {
    if (!existsSync(path.join(resourceDir, relativePath))) {
      problems.push(`缺少许可声明文件：resources/${relativePath}`);
    }
  }

  const appResourceDir = path.join(resourceDir, "app-resources");
  if (existsSync(appResourceDir)) {
    for (const name of MUST_NOT_SHIP_ASSETS) {
      const target = path.join(appResourceDir, name);
      if (existsSync(target)) problems.push(`随包分发的资产（应由服务器下发）：app-resources/${name}`);
    }
  }

  if (problems.length) {
    console.error("[verify-package] 安装包里出现了不该有的东西，构建中止：");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("[verify-package] 处理办法：检查 .env 是否被 Next 的 standalone 复制带走、清理 release/ 后重打。");
    process.exit(1);
  }

  console.log(`[verify-package] 通过：扫描 ${entries.length} 个条目，未发现密钥、数据库、授权令牌、随包资产或缺失的许可声明。`);
}

main();
