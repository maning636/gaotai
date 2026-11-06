/**
 * 自定义 CSS 来源提取。
 *
 * 从 Markdown 文本中提取 `<style>` 块的 CSS；没有 style 块时返回原文本。
 * 逻辑移植自 obsidian-wechat-converter services/custom-css-source.js
 * （MIT 开源协议适配），按稿台需求收敛为 Markdown → style 块提取。
 */

export type CustomCssExtractResult = {
  /** 提取出的 CSS 文本。 */
  css: string;
  /** 移除 CSS 块后剩余的文本。 */
  remaining: string;
};

/**
 * 从 Markdown 文本中提取 `<style>` 块的 CSS。
 *
 * 支持两种写法：
 * - HTML 风格：`<style>...</style>` 或 `<style type="text/css">...</style>`
 * - Markdown 围栏：````css ... ````（```css 或 ~~~css 开头）
 *
 * 没有任何 CSS 块时，css 为空、remaining 为原文。
 */
export function extractCustomCssFromMarkdown(text: string): CustomCssExtractResult {
  const source = String(text || "");
  const cssBlocks: string[] = [];

  // 1. HTML <style> 块。
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  const withoutStyle = source.replace(styleRe, (_whole, inner: string) => {
    cssBlocks.push(inner.trim());
    return "";
  });

  // 2. Markdown 围栏（```css 或 ~~~css）。
  const remaining = withoutStyle.replace(
    /^\s*(`{3,}|~{3,})\s*css(?:\s+.*)?\s*$\n?([\s\S]*?)^\s*\1{3,}\s*$/gim,
    (_whole, _fence: string, inner: string) => {
      cssBlocks.push(inner.trim());
      return "";
    },
  );

  return {
    css: cssBlocks.filter(Boolean).join("\n\n"),
    remaining: remaining.trim(),
  };
}
