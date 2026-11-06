import hljs from "highlight.js/lib/core";
// 只注册常见语言：highlight.js 全量包约 1MB，塞进客户端 bundle 会拖垮首屏。
// 按需注册后，用到的语言各自只有几 KB。语言不在表里时高亮退化成转义纯文本。
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import java from "highlight.js/lib/languages/java";
import go from "highlight.js/lib/languages/go";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";
import dockerfile from "highlight.js/lib/languages/dockerfile";

/**
 * 代码语法高亮 → 带内联样式的 HTML。
 *
 * 公众号编辑器不接受 <link> 样式表，highlight.js 默认输出 `<span class="hljs-xxx">`，
 * 到了公众号里 class 一律被剥掉，高亮全丢。所以这里不走默认输出，而是用
 * highlight() 拿到 token 流，给每种 token 类型映射一个**内联 color**，
 * 拼成带 style 的 `<span>`。
 *
 * 每种语言的颜色走同一套基调（GitHub Dark 语义色），保证多语言代码块放一起不跳色。
 */

// 注册语言表：别名 → 语言模块。用 getLanguage 检查存在性，所以这里重复注册无害。
const LANGUAGES: [string, typeof javascript][] = [
  ["javascript", javascript],
  ["typescript", typescript],
  ["python", python],
  ["bash", bash],
  ["shell", bash],
  ["json", json],
  ["css", css],
  ["xml", xml],
  ["html", xml],
  ["markdown", markdown],
  ["md", markdown],
  ["yaml", yaml],
  ["yml", yaml],
  ["java", java],
  ["go", go],
  ["cpp", cpp],
  ["c", cpp],
  ["csharp", csharp],
  ["cs", csharp],
  ["rust", rust],
  ["sql", sql],
  ["php", php],
  ["ruby", ruby],
  ["kotlin", kotlin],
  ["swift", swift],
  ["diff", diff],
  ["ini", ini],
  ["dockerfile", dockerfile],
];

for (const [alias, lang] of LANGUAGES) {
  if (!hljs.getLanguage(alias)) {
    hljs.registerLanguage(alias, lang);
  }
}

/** token 类型 → 颜色。GitHub Dark 语义色。 */
const TOKEN_COLORS: Record<string, string> = {
  // 关键字 / 控制流 / 运算符
  keyword: "#ff7b72",
  "keyword.control": "#ff7b72",
  "keyword.operator": "#ff7b72",
  "keyword.other": "#ff7b72",
  // 字符串 / 字符 / 正则
  string: "#a5d6ff",
  "string.special": "#a5d6ff",
  "string.regexp": "#a5d6ff",
  // 注释 / 文档注释
  comment: "#8b949e",
  "comment.doc": "#8b949e",
  // 数字 / 字面量 / 常量
  number: "#79c0ff",
  "number.hex": "#79c0ff",
  literal: "#79c0ff",
  "literal.number": "#79c0ff",
  constant: "#79c0ff",
  // 函数 / 方法
  "title.function": "#d2a8ff",
  "title.function.invoke": "#d2a8ff",
  function: "#d2a8ff",
  "meta.function-call": "#d2a8ff",
  // 类名 / 类型 / 结构体
  "title.class": "#ffa657",
  "title.class.inherited": "#ffa657",
  "title.type": "#ffa657",
  type: "#ffa657",
  // 变量 / 参数 / 属性访问
  variable: "#f0f6fc",
  "variable.language": "#ff7b72",
  "variable.parameter": "#f0f6fc",
  "variable.constant": "#79c0ff",
  // 属性名 / 键
  "attr-name": "#ffa657",
  attribute: "#ffa657",
  // 标签 / 选择器
  tag: "#7ee787",
  "selector-tag": "#7ee787",
  "selector-id": "#79c0ff",
  "selector-class": "#ffa657",
  // 内建常量 / 内置类型 / 宏
  built_in: "#ffa657",
  "built_in.class": "#ffa657",
  meta: "#79c0ff",
  // 运算符 / 标点
  operator: "#ff7b72",
  punctuation: "#f0f6fc",
  // 模板字符串插值
  subst: "#f0f6fc",
  // 默认回退
  default: "#f0f6fc",
};

/** 转义 HTML 文本（代码内容必须转义，不能透传成标签）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 把 highlight.js 的输出（含 class="hljs-xxx" 的 span）改写成内联 color 的 span。
 * 输入已是 hljs 转义过的安全 HTML（文本已 &lt;/&gt;/&amp; 转义），
 * 这里**不再转义**，只换标签：未识别的 token 类型落默认正文色，不丢内容。
 * 内层嵌套（如 string 里的 subst）递归处理。
 */
function inlineTokens(highlighted: string): string {
  const re = /<span class="hljs-([a-z0-9 .-]+)">([\s\S]*?)<\/span>/g;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(highlighted))) {
    out += highlighted.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const classes = match[1].trim();
    const color = TOKEN_COLORS[classes] ?? TOKEN_COLORS.default ?? "#f0f6fc";
    const inner = match[2].includes("class=") ? inlineTokens(match[2]) : match[2];
    out += `<span style="color: ${color};">${inner}</span>`;
  }
  out += highlighted.slice(cursor);
  return out;
}

/**
 * 高亮一段代码，返回带内联样式的 HTML（不含 <pre>/<code> 外壳）。
 *
 * - 语言存在且能高亮：逐 token 上色。
 * - 语言不存在 / 高亮失败：退回转义后的纯文本（不丢内容）。
 * - 换行转成 `<br />`：公众号不保证保留 pre 的空白样式。
 */
export function highlightCode(code: string, lang: string): string {
  const normalized = (lang || "").toLowerCase().trim();
  const source = code.replace(/\r\n?/g, "\n");

  let inlined: string;
  if (normalized && hljs.getLanguage(normalized)) {
    try {
      const highlighted = hljs.highlight(source, { language: normalized }).value;
      inlined = inlineTokens(highlighted);
    } catch {
      // 高亮失败：退成转义纯文本（inlineTokens 会再转义一次，所以这里不预转义）。
      inlined = escapeHtml(source);
    }
  } else {
    // 语言不存在：转义纯文本，不丢内容。
    inlined = escapeHtml(source);
  }

  // 换行转成显式 br：公众号里 pre 的空白样式不被保证。
  return inlined.replace(/\n/g, "<br />");
}
