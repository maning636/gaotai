/**
 * 自定义 CSS 内联器。
 *
 * 把已编译的自定义 CSS 安全地应用到文章 HTML。
 * - `applyCompiledCustomCss(html, compiled, options)`：用 juice 内联
 * - `inlineCustomCss(html, cssText, options)`：raw CSS 便捷入口
 *
 * fail-open：CSS 失败时返回原 HTML，不中断预览、复制或同步。
 * 逻辑移植自 obsidian-wechat-converter services/custom-css-inliner.js
 * （MIT 开源协议适配），用 TypeScript 重写。
 */

import juice from "juice";
import { compileCustomCss, DEFAULT_ROOT_SELECTOR, type CustomCssCompileResult, type CustomCssDiagnostic } from "./compiler";

export { compileCustomCss, DEFAULT_ROOT_SELECTOR } from "./compiler";
export type { CustomCssCompileResult, CustomCssDiagnostic } from "./compiler";
export { extractCustomCssFromMarkdown } from "./source";

/** 内联选项。 */
export type CustomCssInlineOptions = {
  /** 保留 !important（默认 true）。 */
  preserveImportant?: boolean;
  /** 移除 <style> 标签（默认 true）。 */
  removeStyleTags?: boolean;
  /** 根作用域选择器。 */
  rootSelector?: string;
};

/** 内联结果。 */
export type CustomCssInlineResult = {
  html: string;
  applied: boolean;
  diagnostics: CustomCssDiagnostic[];
  sourceHash: string;
  matchedRuleCount: number;
  matchedElementCount: number;
};

/** 兼容校验入口。blocked 规则会被移除并作为 diagnostics 返回；只有 fatal 结果不可用。 */
export function sanitizeCustomCss(cssText: string): { usable: boolean; diagnostics: CustomCssDiagnostic[] } {
  const compiled = compileCustomCss(cssText);
  return { usable: compiled.usable, diagnostics: compiled.diagnostics };
}

/** 兼容作用域入口，内部已改用 AST。 */
export function scopeCustomCss(cssText: string, rootSelector = DEFAULT_ROOT_SELECTOR): string {
  return compileCustomCss(cssText, { rootSelector }).scopedCss;
}

/** 移除包裹用的根容器 div（juice 内联后还原）。 */
function unwrapRootContainer(html: string, rootClass: string): string {
  const openRe = new RegExp(`^\\s*<div\\s+class=["']${rootClass}["'][^>]*>`, "i");
  const closeRe = /<\/div>\s*$/i;
  if (!openRe.test(html) || !closeRe.test(html)) return html;
  return html.replace(openRe, "").replace(closeRe, "");
}

/** 统计选择器匹配数（DOM 环境不可用时安全返回 0）。 */
function countSelectorMatches(
  wrappedHtml: string,
  selectors: string[],
): { matchedRuleCount: number; matchedElementCount: number } {
  if (typeof DOMParser === "undefined" || !Array.isArray(selectors) || selectors.length === 0) {
    return { matchedRuleCount: 0, matchedElementCount: 0 };
  }
  const doc = new DOMParser().parseFromString(wrappedHtml, "text/html");
  const container = doc.body.firstElementChild;
  if (!container) return { matchedRuleCount: 0, matchedElementCount: 0 };

  let matchedRuleCount = 0;
  const matchedElements = new Set<Element>();
  selectors.forEach(selector => {
    try {
      const elements = Array.from(container.querySelectorAll(selector));
      if (elements.length > 0) matchedRuleCount += 1;
      elements.forEach(element => matchedElements.add(element));
    } catch {
      // compiler 已负责 selector 诊断；运行环境不支持时只视为未匹配。
    }
  });
  return { matchedRuleCount, matchedElementCount: matchedElements.size };
}

/**
 * Juice 的选择器切分器无法匹配属性字符串中含逗号的合法选择器。
 * 对 compiler 明确标记的这类规则使用 DOM fallback，并保持"普通声明不覆盖既有
 * inline，!important 可以覆盖"的既有优先级合同。
 */
function applyFallbackRules(
  wrappedHtml: string,
  rules: Array<{ selector: string; properties: Record<string, string> }>,
): string {
  if (typeof DOMParser === "undefined" || !rules.length) return wrappedHtml;
  const doc = new DOMParser().parseFromString(wrappedHtml, "text/html");
  const container = doc.body.firstElementChild;
  if (!container) return wrappedHtml;

  rules.forEach(rule => {
    const elements = Array.from(container.querySelectorAll(rule.selector));
    elements.forEach(element => {
      const htmlElement = element as HTMLElement;
      Object.entries(rule.properties).forEach(([property, rawValue]) => {
        const important = /\s*!important\s*$/i.test(rawValue);
        const value = rawValue.replace(/\s*!important\s*$/i, "").trim();
        if (htmlElement.style.getPropertyValue(property) && !important) return;
        htmlElement.style.setProperty(property, value, important ? "important" : "");
      });
    });
  });
  return container.outerHTML;
}

/**
 * 把已编译的自定义 CSS 应用到文章 HTML。
 *
 * @param html 干净文章 HTML。
 * @param compiled compiler 生成的编译结果。
 * @param options 内联选项。
 * @returns 内联后的 HTML 与统计信息。
 */
export function applyCompiledCustomCss(
  html: string,
  compiled: CustomCssCompileResult,
  options: CustomCssInlineOptions = {},
): CustomCssInlineResult {
  const inputHtml = String(html || "");
  const diagnostics = Array.isArray(compiled?.diagnostics) ? [...compiled.diagnostics] : [];
  const sourceHash = String(compiled?.sourceHash || "");
  const noop = (): CustomCssInlineResult => ({
    html: inputHtml,
    applied: false,
    diagnostics,
    sourceHash,
    matchedRuleCount: 0,
    matchedElementCount: 0,
  });

  if (!inputHtml || !compiled?.usable) return noop();
  if (!compiled.scopedCss && (!compiled.pseudoRules || compiled.pseudoRules.length === 0)) return noop();

  const rootSelector = options.rootSelector || DEFAULT_ROOT_SELECTOR;
  const rootClass = rootSelector.replace(/^\./, "");
  const wrappedHtml = `<div class="${rootClass}">${inputHtml}</div>`;

  try {
    const matchSummary = countSelectorMatches(wrappedHtml, compiled.matchSelectors ?? []);
    const fallbackHtml = applyFallbackRules(wrappedHtml, compiled.fallbackRules ?? []);
    // 伪元素：juice 无法内联 ::before/::after，用独立渲染器处理。
    const pseudoResult = prerenderPseudoElements(
      fallbackHtml,
      compiled.pseudoRules ?? [],
      compiled.counterConfig ?? { resets: [], increments: [] },
    );
    const inlined = juice.inlineContent(pseudoResult.html, compiled.scopedCss, {
      preserveImportant: options.preserveImportant !== false,
      removeStyleTags: options.removeStyleTags !== false,
      webResources: { images: false, svgs: false },
    });
    const finalHtml = unwrapRootContainer(inlined, rootClass);
    // applied 判定不依赖 DOMParser（Node 无 DOM）：内联前后 HTML 有实际变化即视为已应用。
    const changed = finalHtml !== inputHtml;
    return {
      html: finalHtml,
      applied: changed || matchSummary.matchedRuleCount > 0 || pseudoResult.insertedCount > 0,
      diagnostics,
      sourceHash,
      matchedRuleCount: matchSummary.matchedRuleCount + (pseudoResult.insertedCount > 0 ? 1 : 0),
      matchedElementCount: matchSummary.matchedElementCount + pseudoResult.insertedCount,
    };
  } catch (error) {
    const errorMessage = String(error || "").replace(/^Error:\s*/i, "");
    diagnostics.push({
      severity: "fatal",
      code: "custom-css-inline-failed",
      message: `自定义 CSS 应用失败，已继续使用基础主题：${errorMessage || "未知错误"}`,
    });
    return {
      html: inputHtml,
      applied: false,
      diagnostics,
      sourceHash,
      matchedRuleCount: 0,
      matchedElementCount: 0,
    };
  }
}

/**
 * raw CSS 兼容入口。
 *
 * 新代码优先显式 compile 后调用 applyCompiledCustomCss。
 * fail-open：CSS 失败时返回输入 HTML。
 */
export function inlineCustomCss(html: string, cssText: string, options: CustomCssInlineOptions = {}): string {
  if (!cssText || !String(cssText).trim()) return html;
  const compiled = compileCustomCss(cssText, {
    sourceIdentity: "direct",
    rootSelector: options.rootSelector || DEFAULT_ROOT_SELECTOR,
  });
  return applyCompiledCustomCss(html, compiled, options).html;
}

/* ------------------------------------------------------------------ *
 * 伪元素渲染（juice 不支持 ::before/::after，DOM 兜底）。
 * ------------------------------------------------------------------ */

type CompiledPseudoRuleLike = {
  baseSelector: string;
  pseudoType: "before" | "after";
  properties: Record<string, string>;
};

type PseudoRenderResult = { html: string; insertedCount: number };

/** 用 DOM 把伪元素规则渲染成真实元素（juice 无法内联伪元素）。 */
function prerenderPseudoElements(
  html: string,
  pseudoRules: CompiledPseudoRuleLike[],
  counterConfig: { resets: Array<{ selector: string; name: string; value: number }>; increments: Array<{ selector: string; name: string; value: number }> },
): PseudoRenderResult {
  if (typeof DOMParser === "undefined" || !pseudoRules.length) return { html, insertedCount: 0 };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const container = doc.body.firstElementChild;
  if (!container) return { html, insertedCount: 0 };

  // 计数器：先 resets 再 increments，按选择器依次作用。
  counterConfig.resets.forEach(reset => {
    container.querySelectorAll(reset.selector).forEach(el => {
      (el as HTMLElement).style.setProperty(`--gt-counter-${reset.name}`, String(reset.value));
    });
  });
  counterConfig.increments.forEach(increment => {
    container.querySelectorAll(increment.selector).forEach(el => {
      const current = Number((el as HTMLElement).style.getPropertyValue(`--gt-counter-${increment.name}`) || "0");
      (el as HTMLElement).style.setProperty(`--gt-counter-${increment.name}`, String(current + increment.value));
    });
  });

  let insertedCount = 0;
  pseudoRules.forEach(rule => {
    let elements: NodeListOf<Element>;
    try {
      elements = container.querySelectorAll(rule.baseSelector);
    } catch {
      return;
    }
    elements.forEach(element => {
      const span = doc.createElement("span");
      span.setAttribute("data-gt-pseudo", rule.pseudoType);
      span.setAttribute("data-gt-owner", String(insertedCount));
      span.style.display = "inline-block";
      Object.entries(rule.properties).forEach(([property, rawValue]) => {
        const important = /\s*!important\s*$/i.test(rawValue);
        const value = rawValue.replace(/\s*!important\s*$/i, "").trim();
        span.style.setProperty(property, value, important ? "important" : "");
      });
      element.appendChild(span);
      insertedCount += 1;
    });
  });
  return { html: container.outerHTML, insertedCount };
}
