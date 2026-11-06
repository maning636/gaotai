/**
 * 自定义 CSS 编译器。
 *
 * 使用 postcss AST 做安全清理、选择器展开与作用域改写：
 * - 移除 @import / @font-face / @keyframes
 * - 移除 behavior / binding 属性、expression()、外部 URL、超限 data image
 * - 展开 :is() / :where()，跳过 :has()
 * - 提取 ::before / ::after 伪元素为 pseudoRules
 * - LRU 32 条内容 hash 缓存
 *
 * 逻辑移植自 obsidian-wechat-converter services/custom-css-compiler.js
 * （MIT 开源协议适配），用 TypeScript 重写。
 */

import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";

/** 默认根作用域选择器。 */
export const DEFAULT_ROOT_SELECTOR = ".gt-article-root";

/** 单个 data image 大小上限（字节）。 */
const DEFAULT_MAX_DATA_IMAGE_BYTES = 256 * 1024;
/** data image 总大小上限（字节）。 */
const DEFAULT_MAX_TOTAL_DATA_IMAGE_BYTES = 512 * 1024;
/** 允许的 data image MIME。 */
const SAFE_DATA_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** 编译缓存上限（LRU）。 */
const COMPILE_CACHE_LIMIT = 32;

/** 诊断严重级别。 */
export type CustomCssDiagnosticSeverity = "fatal" | "blocked" | "warning" | "info";

/** 一条诊断。 */
export type CustomCssDiagnostic = {
  severity: CustomCssDiagnosticSeverity;
  code: string;
  message: string;
  line?: number;
  column?: number;
};

/** 提取出的伪元素规则。 */
export type CompiledPseudoRule = {
  baseSelector: string;
  pseudoType: "before" | "after";
  properties: Record<string, string>;
};

/** 计数器配置。 */
export type CompiledCounterConfig = {
  resets: Array<{ selector: string; name: string; value: number }>;
  increments: Array<{ selector: string; name: string; value: number }>;
};

/** 编译结果。 */
export type CustomCssCompileResult = {
  sourceIdentity: string;
  sourceHash: string;
  scopedCss: string;
  pseudoRules: CompiledPseudoRule[];
  fallbackRules: Array<{ selector: string; properties: Record<string, string> }>;
  counterConfig: CompiledCounterConfig;
  matchSelectors: string[];
  diagnostics: CustomCssDiagnostic[];
  usable: boolean;
  capability: { parseable: boolean; scopeable: boolean };
};

/** 编译选项。 */
export type CustomCssCompileOptions = {
  sourceIdentity?: string;
  rootSelector?: string;
  maxDataImageBytes?: number;
  maxTotalDataImageBytes?: number;
};

/** 内容 hash 缓存。 */
const compileCache = new Map<string, CustomCssCompileResult>();

/** 计算 CSS 文本的 FNV-1a hash。 */
export function hashCustomCss(value: string): string {
  let hash = 2166136261;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 从 postcss 节点取行列信息。 */
function sourcePosition(node: unknown): { line?: number; column?: number } {
  const source = (node as { source?: { start?: { line?: number; column?: number } } } | null)?.source;
  const start = source?.start;
  return {
    ...(start?.line ? { line: start.line } : {}),
    ...(start?.column ? { column: start.column } : {}),
  };
}

/** 创建诊断。 */
function createDiagnostic(
  node: unknown,
  severity: CustomCssDiagnosticSeverity,
  code: string,
  message: string,
): CustomCssDiagnostic {
  return { severity, code, message, ...sourcePosition(node) };
}

/** 移除 ASCII 控制字符。 */
function stripAsciiControlCharacters(value: string): string {
  return Array.from(String(value || ""))
    .filter(character => {
      const codePoint = character.codePointAt(0) || 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("");
}

/** 解码 CSS 转义（\\XXXXXX 与 \\X）。 */
function decodeCssEscapes(value: string): string {
  const decoded = String(value || "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex) => {
      const codePoint = Number.parseInt(String(hex), 16);
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return "";
      }
    })
    .replace(/\\(.)/g, "$1")
    .trim();
  return stripAsciiControlCharacters(decoded).trim();
}

/** 规范化 URL 值（去引号、解转义）。 */
function normalizeUrlValue(value: string): string {
  let normalized = decodeCssEscapes(value).replace(/^['"]|['"]$/g, "").trim();
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) break;
      normalized = decoded;
    } catch {
      break;
    }
  }
  return stripAsciiControlCharacters(normalized).trim();
}

/** data image 检查结果。 */
function inspectDataImage(dataUrl: string): { ok: boolean; bytes: number; reason?: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return { ok: false, bytes: 0, reason: "只允许 base64 编码的图片 data URL。" };
  const mime = match[1].toLowerCase();
  if (!SAFE_DATA_IMAGE_MIMES.has(mime)) {
    return { ok: false, bytes: 0, reason: `不支持 ${mime} 类型的 data URL。` };
  }
  const payload = match[2].replace(/\s+/g, "");
  const padding = payload.match(/=*$/)?.[0].length ?? 0;
  return {
    ok: true,
    bytes: Math.max(0, Math.floor((payload.length * 3) / 4) - padding),
  };
}

type ResourceState = {
  dataImageBytes: number;
  maxDataImageBytes: number;
  maxTotalDataImageBytes: number;
};

/** 清理单条声明：返回是否保留。 */
function sanitizeDeclaration(
  declaration: postcss.Declaration,
  diagnostics: CustomCssDiagnostic[],
  resourceState: ResourceState,
): boolean {
  const property = declaration.prop.trim().toLowerCase();
  if (property === "behavior" || property === "-ms-behavior" || property === "binding") {
    diagnostics.push(
      createDiagnostic(declaration, "blocked", "custom-css-dangerous-property", `已移除不安全属性 ${declaration.prop}。`),
    );
    declaration.remove();
    return false;
  }

  if (/expression\s*\(/i.test(declaration.value)) {
    diagnostics.push(
      createDiagnostic(declaration, "blocked", "custom-css-expression-blocked", `已移除包含 expression() 的 ${declaration.prop}。`),
    );
    declaration.remove();
    return false;
  }

  let blockedReason = "";
  const parsedValue = valueParser(declaration.value);
  parsedValue.walk(node => {
    if (blockedReason || node.type !== "function" || node.value.toLowerCase() !== "url") return;
    const normalized = normalizeUrlValue(valueParser.stringify(node.nodes));
    const lower = normalized.toLowerCase();
    if (lower.startsWith("data:")) {
      const inspection = inspectDataImage(normalized);
      if (!inspection.ok) {
        blockedReason = inspection.reason ?? "不支持该 data URL。";
        return;
      }
      if (inspection.bytes > resourceState.maxDataImageBytes) {
        blockedReason = "单个 data image 超出大小限制。";
        return;
      }
      if (resourceState.dataImageBytes + inspection.bytes > resourceState.maxTotalDataImageBytes) {
        blockedReason = "CSS 中的 data image 总量超出大小限制。";
        return;
      }
      resourceState.dataImageBytes += inspection.bytes;
      return;
    }
    if (lower.startsWith("#")) return;
    blockedReason = "外部或相对 URL 可能触发网络请求。";
  });

  if (blockedReason) {
    diagnostics.push(
      createDiagnostic(declaration, "blocked", "custom-css-resource-url-blocked", `已移除 ${declaration.prop}：${blockedReason}`),
    );
    declaration.remove();
    return false;
  }

  return true;
}

/** 展开单个选择器里的 :is()/:where()（递归）。 */
function expandSelectorNode(selector: selectorParser.Selector): selectorParser.Selector[] {
  let pseudoIndex = -1;
  const capturedOptions: selectorParser.Selector[] = [];
  let seen = 0;
  selector.walkPseudos(pseudo => {
    if (
      capturedOptions.length > 0 ||
      (pseudo.value.toLowerCase() !== ":is" && pseudo.value.toLowerCase() !== ":where")
    ) {
      seen += 1;
      return;
    }
    pseudoIndex = seen;
    // selector-parser 的 Pseudo.nodes 类型未完整暴露；运行时由 parser 保证。
    capturedOptions.push(...(pseudo.nodes as unknown as selectorParser.Selector[]));
    seen += 1;
  });

  if (capturedOptions.length === 0 || pseudoIndex < 0) return [selector];
  const expanded: selectorParser.Selector[] = [];
  for (const option of capturedOptions) {
    // selector-parser 的节点泛型未完整暴露给类型检查器；运行时结构由 parser 保证。
    // 这里用 unknown 中转：Pseudo 类型在泛型 clone 的 walkPseudos 回调里会被 TS
    // 错误地收窄成 never，导致 replaceWith 报不存在。
    const clone = selector.clone() as unknown as {
      walkPseudos: (cb: (pseudo: { value: string; nodes?: unknown[] }) => void) => void;
    };
    let cloneIndex = 0;
    let targetPseudo: unknown = null;
    clone.walkPseudos(pseudo => {
      if (cloneIndex === pseudoIndex) targetPseudo = pseudo;
      cloneIndex += 1;
    });
    if (!targetPseudo || typeof targetPseudo !== "object") continue;
    const pseudoNode = targetPseudo as {
      replaceWith?: (...nodes: unknown[]) => unknown;
    };
    if (typeof pseudoNode.replaceWith !== "function") continue;
    pseudoNode.replaceWith(
      ...(option.nodes as unknown as selectorParser.Node[]).map(node => node.clone()),
    );
    // 递归展开的是「替换之后」的 clone，不是原始 selector——否则永远在原地打转。
    expanded.push(...expandSelectorNode(clone as unknown as selectorParser.Selector));
  }
  return expanded;
}

/** 展开选择器文本，返回展开后的选择器列表与诊断。 */
function expandSelectors(selectorText: string): { selectors: string[]; diagnostics: CustomCssDiagnostic[] } {
  const diagnostics: CustomCssDiagnostic[] = [];
  const processor = selectorParser();
  const root = processor.astSync(selectorText);
  const selectors: string[] = [];
  root.each(selector => {
    const expanded = expandSelectorNode(selector);
    expanded.forEach(item => {
      let unsupported = false;
      item.walkPseudos(pseudo => {
        if (pseudo.value.toLowerCase() === ":has") unsupported = true;
      });
      if (unsupported) {
        diagnostics.push({
          severity: "warning",
          code: "custom-css-selector-not-inlineable",
          message: `选择器“${item.toString()}”包含暂不支持的 :has()，已跳过。`,
        });
        return;
      }
      selectors.push(item.toString().trim());
    });
  });
  return { selectors, diagnostics };
}

/** 解析伪元素选择器（以 ::before/::after 结尾）。 */
function parsePseudoSelector(selector: string): { baseSelector: string; pseudoType: "before" | "after" } | null {
  const match = selector.match(/::(before|after)\s*$/i);
  if (!match) return null;
  return {
    baseSelector: selector.slice(0, match.index).trim(),
    pseudoType: match[1].toLowerCase() as "before" | "after",
  };
}

/** 把一条 rule 的声明转成 Record。 */
function declarationsToRecord(rule: postcss.Rule): Record<string, string> {
  const properties: Record<string, string> = {};
  rule.nodes?.forEach(node => {
    if (node.type !== "decl") return;
    const decl = node as postcss.Declaration;
    properties[decl.prop] = `${decl.value}${decl.important ? " !important" : ""}`;
  });
  return properties;
}

/** 解析 counter-reset / counter-increment 值。 */
function parseCounterValue(value: string, fallback: number): { name: string; value: number } | null {
  const parts = String(value || "").trim().split(/\s+/);
  const name = parts[0] ?? "";
  if (!name || ["none", "inherit", "initial", "unset"].includes(name.toLowerCase())) return null;
  const parsed = parts.length > 1 ? Number.parseInt(parts[1] ?? "", 10) : fallback;
  if (!Number.isFinite(parsed)) return null;
  return { name, value: parsed };
}

/**
 * 编译自定义 CSS。
 *
 * @param cssText 用户 CSS 文本。
 * @param options 来源 identity、根作用域选择器与资源限制。
 * @returns 编译结果（scopedCss、伪元素规则、诊断与可用性）。
 */
export function compileCustomCss(cssText: string, options: CustomCssCompileOptions = {}): CustomCssCompileResult {
  const css = String(cssText || "");
  const sourceIdentity = String(options.sourceIdentity || "textarea");
  const rootSelector = String(options.rootSelector || DEFAULT_ROOT_SELECTOR).trim();
  const sourceHash = hashCustomCss(`${sourceIdentity}\0${rootSelector}\0${css}`);
  const maxDataImageBytes = options.maxDataImageBytes ?? DEFAULT_MAX_DATA_IMAGE_BYTES;
  const maxTotalDataImageBytes = options.maxTotalDataImageBytes ?? DEFAULT_MAX_TOTAL_DATA_IMAGE_BYTES;
  const cacheKey = `${sourceHash}:${maxDataImageBytes}:${maxTotalDataImageBytes}`;
  const cached = compileCache.get(cacheKey);
  if (cached) return cached;

  const diagnostics: CustomCssDiagnostic[] = [];
  const emptyResult = (usable: boolean, capability: { parseable: boolean; scopeable: boolean }): CustomCssCompileResult => ({
    sourceIdentity,
    sourceHash,
    scopedCss: "",
    pseudoRules: [],
    fallbackRules: [],
    counterConfig: { resets: [], increments: [] },
    matchSelectors: [],
    diagnostics,
    usable,
    capability,
  });

  if (!css.trim()) {
    return emptyResult(true, { parseable: true, scopeable: true });
  }

  let root: postcss.Root;
  try {
    root = postcss.parse(css, { from: undefined });
  } catch (error) {
    const parseError = error as { reason?: string; line?: number; column?: number } | null;
    diagnostics.push({
      severity: "fatal",
      code: "custom-css-parse-failed",
      message: parseError?.reason ?? "CSS 语法无法解析。",
      ...(parseError?.line ? { line: parseError.line } : {}),
      ...(parseError?.column ? { column: parseError.column } : {}),
    });
    return emptyResult(false, { parseable: false, scopeable: false });
  }

  root.walkAtRules(atRule => {
    const name = atRule.name.toLowerCase();
    if (name === "import" || name === "font-face") {
      diagnostics.push(
        createDiagnostic(atRule, "blocked", `custom-css-${name}-blocked`, `已移除不支持的 @${name} 规则。`),
      );
      atRule.remove();
      return;
    }
    if (name.includes("keyframes")) {
      diagnostics.push(
        createDiagnostic(atRule, "warning", "custom-css-animation-unsupported", "微信文章不支持关键帧动画，该规则已移除。"),
      );
      atRule.remove();
    }
  });

  const resourceState: ResourceState = {
    dataImageBytes: 0,
    maxDataImageBytes,
    maxTotalDataImageBytes,
  };
  root.walkDecls(declaration => {
    sanitizeDeclaration(declaration, diagnostics, resourceState);
  });

  const pseudoRules: CompiledPseudoRule[] = [];
  const fallbackRules: Array<{ selector: string; properties: Record<string, string> }> = [];
  const counterConfig: CompiledCounterConfig = { resets: [], increments: [] };
  const matchSelectors: string[] = [];
  let scopeable = true;

  root.walkRules(rule => {
    if (!rule.parent) return;
    let expanded;
    try {
      expanded = expandSelectors(rule.selector);
      diagnostics.push(
        ...expanded.diagnostics.map(item => ({ ...item, ...sourcePosition(rule) })),
      );
    } catch (error) {
      scopeable = false;
      const selectorError = String(error || "").replace(/^Error:\s*/i, "");
      diagnostics.push(
        createDiagnostic(rule, "fatal", "custom-css-selector-parse-failed", `选择器无法解析：${selectorError || rule.selector}`),
      );
      return;
    }

    const properties = declarationsToRecord(rule);
    const regularSelectors: string[] = [];
    expanded.selectors.forEach(selector => {
      const pseudo = parsePseudoSelector(selector);
      if (pseudo) {
        if (pseudo.baseSelector) {
          pseudoRules.push({
            baseSelector: pseudo.baseSelector,
            pseudoType: pseudo.pseudoType,
            properties: { ...properties },
          });
        }
        return;
      }

      regularSelectors.push(selector);
      matchSelectors.push(selector);
      if (/\[[^\]]*["'][^"']*,[^"']*["'][^\]]*\]/.test(selector)) {
        fallbackRules.push({ selector, properties: { ...properties } });
        regularSelectors.pop();
      }
      const reset = parseCounterValue(properties["counter-reset"] ?? "", 0);
      const increment = parseCounterValue(properties["counter-increment"] ?? "", 1);
      if (reset) counterConfig.resets.push({ selector, name: reset.name, value: reset.value });
      if (increment) counterConfig.increments.push({ selector, name: increment.name, value: increment.value });
    });

    if (regularSelectors.length === 0 || !rule.nodes?.some(node => node.type === "decl")) {
      rule.remove();
      return;
    }

    rule.selector = regularSelectors.map(selector => `${rootSelector} ${selector}`).join(", ");
  });

  root.walkRules(rule => {
    if (!rule.nodes?.some(node => node.type === "decl")) rule.remove();
  });

  const usable = scopeable && !diagnostics.some(item => item.severity === "fatal");
  const result: CustomCssCompileResult = {
    sourceIdentity,
    sourceHash,
    scopedCss: usable ? root.toString() : "",
    pseudoRules: usable ? pseudoRules : [],
    fallbackRules: usable ? fallbackRules : [],
    counterConfig: usable ? counterConfig : { resets: [], increments: [] },
    matchSelectors: usable ? Array.from(new Set(matchSelectors)) : [],
    diagnostics,
    usable,
    capability: { parseable: true, scopeable },
  };

  compileCache.set(cacheKey, result);
  if (compileCache.size > COMPILE_CACHE_LIMIT) {
    const firstKey = String(compileCache.keys().next().value ?? "");
    if (firstKey) compileCache.delete(firstKey);
  }
  return result;
}

/** 清空编译缓存（测试用）。 */
export function clearCustomCssCompileCache(): void {
  compileCache.clear();
}
