// 把运行时需要的「只读资源」集中到 dist/app-resources，供 Electron 打包进 extraResources。
// 四个子目录的用途（与 src/lib/paths.ts 的路径契约一一对应）：
//   - prompts      —— 各阶段提示词，写作流程直接读取。
//   - topics       —— 公开示例专题，用户开箱即可试用。
//   - skills       —— 写作技能，供后端 API 拉取。
//   - layout-packs —— 随包分发的排版样式包，作为内置模板开箱即用。
// 四者都是「随安装包分发、用户不改写」的只读资产，与用户自己的数据目录严格分离。
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
// 目标目录可通过参数指定，便于 CI 或本地脚本传入自定义路径。
const targetDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(projectRoot, "dist", "app-resources");

// 源目录 -> 目标目录名。目标名保持扁平：app-resources/prompts、app-resources/topics……
// 与 paths.ts 里的 promptDir()/publicTopicsDir()/skillsDir()/layoutPacksDir() 严格对应。
const SOURCES = [
  { from: "resources/prompts", to: "prompts" },
  { from: "resources/topics", to: "topics" },
  { from: "resources/skills", to: "skills" },
  { from: "resources/layout-packs", to: "layout-packs" },
];

/**
 * 判断「源是否比目标新或不同」：比较 mtime 与 size 即可，足以应付打包场景。
 * 目标不存在、mtime 更新、或 size 不同，都视为需要同步。
 */
function isStale(srcStat, destStat) {
  if (!destStat) return true;
  if (srcStat.mtimeMs > destStat.mtimeMs) return true;
  return srcStat.size !== destStat.size;
}

/** 递归把 src 同步到 dest；只在文件级有差异时重新拷贝。 */
function syncDir(src, dest) {
  const srcStat = lstatSync(src);

  if (srcStat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      syncDir(path.join(src, name), path.join(dest, name));
    }
    return;
  }

  if (srcStat.isFile()) {
    const destStat = existsSync(dest) ? statSync(dest) : null;
    if (!isStale(srcStat, destStat)) return; // 已最新，跳过
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
    return;
  }

  // 符号链接等非常规条目直接跳过，避免打包时踩雷。
}

console.log(`[prepare-resources] project = ${projectRoot}`);
console.log(`[prepare-resources] target  = ${targetDir}`);

// 目标目录若存在旧内容（上一次失败打包的残留），先清空一次，保证最终目录与源码严格一致。
if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
  console.log("[prepare-resources] cleared stale target");
}
mkdirSync(targetDir, { recursive: true });

for (const source of SOURCES) {
  const src = path.join(projectRoot, source.from);
  if (!existsSync(src)) {
    console.warn(`[prepare-resources] skip (missing): ${source.from}`);
    continue;
  }
  syncDir(src, path.join(targetDir, source.to));
  console.log(`[prepare-resources] synced: ${source.from} -> ${source.to}`);
}

console.log(`[prepare-resources] done -> ${targetDir}`);
