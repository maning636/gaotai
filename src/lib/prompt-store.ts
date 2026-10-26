import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promptDir } from "./paths";

/**
 * 提示词模板仓库。
 *
 * 模板放在 resources/prompts/ 下，随安装包分发，是可以直接打开看、可以直接改的产品资产，
 * 而不是散在代码里的字符串常量——用户改提示词不需要重新编译。
 *
 * 缺失的处理原则是「降级而不是崩溃」：模板读不到就返回空串，
 * 由调用方决定用什么兜底，而不是让整个应用起不来。
 */

const cache = new Map<string, string>();

function cacheKey(filePath: string): string {
  return filePath;
}

/** 读一个提示词模板。文件不存在时返回空字符串。 */
export function getPrompt(name: string): string {
  const safeName = name.replace(/[^\w.-]/g, "");
  if (!safeName) return "";
  const filePath = path.join(promptDir(), `${safeName}.md`);
  const cached = cache.get(cacheKey(filePath));
  if (cached !== undefined) return cached;
  try {
    const text = readFileSync(filePath, "utf8");
    cache.set(cacheKey(filePath), text);
    return text;
  } catch {
    cache.set(cacheKey(filePath), "");
    return "";
  }
}

/**
 * 填充模板占位符。
 *
 * 只做一次替换：替换结果里如果又出现 {{...}}，不会被二次解析。
 * 否则模板里写了个含占位符的示例时会把用户内容再扫一遍。
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return typeof value === "string" ? value : "";
  });
}

/** 列出可用的提示词名（不含扩展名）。 */
export function listPromptNames(): string[] {
  try {
    return readdirSync(promptDir())
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** 清空缓存。改完提示词文件后调一次即可生效。 */
export function clearPromptCache(): void {
  cache.clear();
}
