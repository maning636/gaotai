import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 浏览器扩展的定位与信息读取。
 *
 * 多平台分发靠一个 Chrome/Edge 扩展把稿子填进各平台编辑器，而浏览器**没有**
 * 静默安装通道——用户只能自己在扩展管理页里「加载已解压的扩展程序」，
 * 选中一个真实文件夹。所以这个模块的唯一职责是：告诉界面「那个文件夹在哪」，
 * 以及「里面到底是什么版本、支持哪些平台」，让安装指导页说的每一步都能对上。
 */

/**
 * 扩展目录候选。
 *
 * 显式配了 `GAOTAI_EXTENSION_DIR`（桌面客户端总会配）就只认它——
 * 打包态路径是确定的，再去猜别的目录只会把「装错了位置」掩盖成「能用」。
 * 没配时才按开发态的常见位置逐个试。
 */
function candidates(): string[] {
  const fromEnv = process.env.GAOTAI_EXTENSION_DIR?.trim();
  if (fromEnv) return [fromEnv];
  return [
    // 开发态：进程工作目录就在项目根
    path.join(process.cwd(), "extension"),
    // 后端从 .next/standalone 起时，项目根在上两级
    path.join(process.cwd(), "..", "..", "extension"),
    path.join(process.cwd(), "..", "..", "..", "extension"),
  ];
}

export type ExtensionInfo = {
  /** 目录是否存在且像一个可加载的扩展（有 manifest.json）。 */
  available: boolean;
  /** 绝对路径；不可用时为空串。 */
  dir: string;
  /** manifest 里的版本号。 */
  version: string;
  /** manifest 里的名称。 */
  name: string;
  /** 已实现的适配器（文件名的平台 id），不含 types/index/_template。 */
  adapters: string[];
};

const EMPTY: ExtensionInfo = { available: false, dir: "", version: "", name: "", adapters: [] };

/** 列出适配器平台 id，用来确认「扩展是完整的，不是只拷了半个目录」。 */
function listAdapters(dir: string): string[] {
  try {
    return readdirSync(path.join(dir, "platform-adapters"))
      .filter((file) => file.endsWith(".js") && file !== "index.js" && file !== "types.js" && !file.startsWith("_"))
      .map((file) => file.replace(/\.js$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export function readExtensionInfo(): ExtensionInfo {
  for (const dir of candidates()) {
    const manifestPath = path.join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        version?: unknown;
        name?: unknown;
      };
      return {
        available: true,
        dir,
        version: typeof manifest.version === "string" ? manifest.version : "",
        name: typeof manifest.name === "string" ? manifest.name : "",
        adapters: listAdapters(dir),
      };
    } catch {
      // manifest 损坏时继续找下一个候选，别把一个坏目录当成可用
    }
  }
  return EMPTY;
}
