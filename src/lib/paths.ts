import path from "node:path";
import { existsSync } from "node:fs";

/**
 * 路径契约。
 *
 * 稿台把「随安装包分发的只读资源」和「用户自己的可写数据」彻底分开：
 * - 只读资源：提示词、公开示例专题、写作技能、public 静态资源。打包后位于 resources 目录。
 * - 可写数据：.env、SQLite 库、本地专题、登录失败日志、生成的配图。打包后位于用户数据目录。
 *
 * 开发态两个根目录都退回 process.cwd()，因此本地开发与安装后的行为完全一致。
 * Electron 启动时通过环境变量注入实际目录：
 *   GAOTAI_RESOURCE_DIR —— 只读资源根目录
 *   GAOTAI_DATA_DIR     —— 可写数据根目录
 */

// 只读资源根目录：开发态是项目下的 resources/，打包态由 Electron 注入。
// 显式跳过 Turbopack 静态追踪——这些目录属于运行时数据，
// 不应让打包器把整个项目（含 .env 与个人数据）当作依赖追踪进构建产物。
const resourceRoot = () =>
  process.env.GAOTAI_RESOURCE_DIR?.trim() ||
  path.join(/* turbopackIgnore: true */ process.cwd(), "resources");
const dataRoot = () => process.env.GAOTAI_DATA_DIR?.trim() || path.join(/* turbopackIgnore: true */ process.cwd());

/** 只读资源根目录：随应用安装分发，不允许写入。 */
export function resourceDir(): string {
  return resourceRoot();
}

/** 可写数据根目录：数据库、密钥、本地素材与日志都落在这里。 */
export function dataDir(): string {
  return dataRoot();
}

/** 只读资源：各阶段提示词。 */
export function promptDir(): string {
  return path.join(resourceRoot(), "prompts");
}

/** 只读资源：公开示例专题。 */
export function publicTopicsDir(): string {
  return path.join(resourceRoot(), "topics");
}

/** 只读资源：写作技能。 */
export function skillsDir(): string {
  return path.join(resourceRoot(), "skills");
}

/**
 * 只读资源：随包分发的排版样式包。
 *
 * 这些是一份份 JSON，描述「我这几个部件长什么样」。
 * 它们是**内置模板**：开箱即用、只读，想改就复制一份变成自己的。
 */
export function layoutPacksDir(): string {
  return path.join(resourceRoot(), "layout-packs");
}

/** 可写数据：SQLite 等本地数据的存放目录。 */
export function dataStorageDir(): string {
  return path.join(dataRoot(), "data");
}

/** 可写数据：本地新增或覆盖的专题目录。 */
export function localTopicsDir(): string {
  return path.join(dataStorageDir(), "local", "topics");
}

/** 可写数据：登录失败日志。 */
export function loginFailuresFile(): string {
  return path.join(dataStorageDir(), "login-failures.jsonl");
}

/** 可写数据：模型配置（密钥加密后存储）。 */
export function agentConfigFile(): string {
  return path.join(dataStorageDir(), "agent-config.json");
}

/**
 * 密钥文件位置。
 *
 * 显式设置了 GAOTAI_DATA_DIR（桌面客户端）时，密钥只认数据目录下的 .env：
 * 借用项目根的 .env 会让桌面版读到开发机上的旧密钥，也让引导逻辑判断失真。
 * 开发态（未设置覆盖）才回退到项目根的 .env，保持本地开发体验不变。
 */
export function envFile(): string {
  if (process.env.GAOTAI_DATA_DIR?.trim()) return path.join(dataRoot(), ".env");
  const inProject = path.join(/* turbopackIgnore: true */ process.cwd(), ".env");
  if (existsSync(inProject)) return inProject;
  return path.join(dataRoot(), ".env");
}

/** 可写数据：本地生成的配图目录。 */
export function imagesDir(): string {
  return path.join(dataRoot(), "images");
}

/**
 * public 静态资源目录。
 *
 * Next 的 standalone 产物要求 public 位于 server.js 同级，因此这里跟随进程工作目录：
 * 开发态是项目根，打包态是 .next/standalone，两种模式下 public 都紧邻 server.js。
 */
export function publicDir(): string {
  // 显式跳过 Turbopack 静态追踪：public 目录由构建脚本单独复制进 standalone。
  return path.join(/* turbopackIgnore: true */ process.cwd(), "public");
}
