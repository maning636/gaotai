import { escapeHtml, styleText } from "./html-util";
import { THEME_NAMES, THEME_PALETTES, type ThemeId } from "./wx-theme";

/**
 * 排版模板。
 *
 * 一篇稿子排成什么样，本质上是一堆「部件」各长什么样：
 * 标题、正文段落、引用、代码块、表格……每个部件是一段 HTML 模板，
 * 内容用 {{content}} 占位，颜色这类值用 {{变量名}} 占位。
 *
 * 这么拆的好处是三件事同时成立：
 *
 * 1. **可取舍**：包里的部件可以不勾。头尾这类"包作者自己加的"不要，
 *    直接从包里剔掉，正文照样排。
 * 2. **可固化**：勾完的部件存进数据库就是一套模板，随时能取用。
 * 3. **可迭代**：模板存在库里，改颜色、改某个部件的 html，再存一次就是新版本。
 *
 * 外部样式包（像 skills 那样一份一个目录）落地成本也因此很低：
 * 包就是一份 JSON，描述"我这几个部件长什么样"；
 * 稿台这边只认部件，不认包的来历。
 */

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 部件标识。新增部件时编译器会列出所有取值处，漏改一处就编译失败。 */
export type LayoutPartKey =
  | "root"
  | "lead"
  | "title"
  | "heading"
  | "heading3"
  | "heading4"
  | "paragraph"
  | "strong"
  | "em"
  | "delete"
  | "inlineCode"
  | "quote"
  | "list"
  | "listItem"
  | "code"
  | "table"
  | "tableHead"
  | "tableCell"
  | "image"
  | "divider"
  | "link"
  | "closing"
  | "footer";

/**
 * 部件的落位。
 *
 * - inline：正文里遇到对应元素时用它（段落、标题、引用……）。
 * - head：整篇最前面插一块（开篇引子、题图说明）。
 * - tail：整篇最后面插一块（结尾语、落款）。
 * - root：整篇的外壳，把所有内容包起来。
 */
export type LayoutPlacement = "inline" | "head" | "tail" | "root";

/** 一个部件。 */
export type LayoutPart = {
  key: LayoutPartKey;
  /** 中文名，界面上显示。 */
  name: string;
  /** 是否启用。关掉 head/tail 部件等于整块不输出；关掉 inline 部件等于退回内置默认样式。 */
  enabled: boolean;
  /** 落位。 */
  placement: LayoutPlacement;
  /** HTML 模板。{{content}} 是内容占位，其余 {{xxx}} 取模板变量或渲染上下文。 */
  html: string;
  /** 固定文本。head/tail 部件用它当内容；inline 部件忽略它。 */
  text?: string;
};

/** 一套排版模板。 */
export type LayoutTemplate = {
  id: string;
  name: string;
  description: string;
  /** builtin=内置样板（只读）、imported=从样式包导入、custom=自己改出来的。 */
  source: "builtin" | "imported" | "custom";
  /** 变量表：色值等。模板 html 里的 {{变量名}} 从这里取。 */
  vars: Record<string, string>;
  /**
   * 部件覆盖表。
   *
   * 只有写在这里的部件才会用自己的样式；没写的部件用内置默认样式，
   * 颜色则一律取 vars。所以"改一个色值，全篇跟着变"这件事成立。
   */
  parts: LayoutPart[];
};

/* ------------------------------------------------------------------ *
 * 部件目录
 * ------------------------------------------------------------------ */

export type PartMeta = {
  key: LayoutPartKey;
  name: string;
  placement: LayoutPlacement;
  /** 界面分组。 */
  group: string;
  /** 一句话说明这个部件管什么。 */
  hint: string;
};

/**
 * 全部部件。
 *
 * 顺序就是界面上的展示顺序：先整体，再头，再正文块，再尾。
 */
export const PART_CATALOG: PartMeta[] = [
  {
    key: "root",
    name: "整篇外壳",
    placement: "root",
    group: "整体",
    hint: "把所有内容包起来的那层，决定字号、行距与底色。",
  },
  {
    key: "lead",
    name: "开篇",
    placement: "head",
    group: "头",
    hint: "正文最前面的一块。样式包里常有作者自己写的引子，不要就整块去掉。",
  },
  {
    key: "title",
    name: "主标题",
    placement: "inline",
    group: "头",
    hint: "正文里的一级标题。公众号标题是单独填的，正文里很少再写一遍。",
  },
  {
    key: "heading",
    name: "小标题",
    placement: "inline",
    group: "正文",
    hint: "二级标题。正文里最常见的那层小标题。",
  },
  {
    key: "heading3",
    name: "三级标题",
    placement: "inline",
    group: "正文",
    hint: "三级标题。主题给每一级标题单独配过样式时，这一层才看得出差别。",
  },
  {
    key: "heading4",
    name: "四级标题",
    placement: "inline",
    group: "正文",
    hint: "四级标题。再深就都是它了。",
  },
  {
    key: "paragraph",
    name: "正文段落",
    placement: "inline",
    group: "正文",
    hint: "正文的主要形状。字号、行距、对齐都在这里。",
  },
  {
    key: "strong",
    name: "加粗",
    placement: "inline",
    group: "正文",
    hint: "正文里的加粗片段。",
  },
  {
    key: "em",
    name: "斜体",
    placement: "inline",
    group: "正文",
    hint: "正文里的斜体片段。",
  },
  {
    key: "delete",
    name: "删除线",
    placement: "inline",
    group: "正文",
    hint: "正文里的删除线片段。",
  },
  {
    key: "inlineCode",
    name: "行内代码",
    placement: "inline",
    group: "正文",
    hint: "夹在正文里的 `代码`。",
  },
  {
    key: "quote",
    name: "引用",
    placement: "inline",
    group: "块",
    hint: "引用的一段话。",
  },
  {
    key: "list",
    name: "列表",
    placement: "inline",
    group: "块",
    hint: "无序列表与有序列表的外框。",
  },
  {
    key: "listItem",
    name: "列表项",
    placement: "inline",
    group: "块",
    hint: "列表里的每一项。",
  },
  {
    key: "code",
    name: "代码块",
    placement: "inline",
    group: "块",
    hint: "整块代码。带窗口顶栏和三个圆点。",
  },
  {
    key: "table",
    name: "表格",
    placement: "inline",
    group: "块",
    hint: "表格的外框，负责横向滚动。",
  },
  {
    key: "tableHead",
    name: "表头",
    placement: "inline",
    group: "块",
    hint: "表格第一行的格子。",
  },
  {
    key: "tableCell",
    name: "表格单元",
    placement: "inline",
    group: "块",
    hint: "表格里的普通格子。",
  },
  {
    key: "image",
    name: "图片",
    placement: "inline",
    group: "块",
    hint: "正文里的插图。",
  },
  {
    key: "divider",
    name: "分隔线",
    placement: "inline",
    group: "块",
    hint: "单独一行横线。",
  },
  {
    key: "link",
    name: "链接",
    placement: "inline",
    group: "正文",
    hint: "正文里的可点击链接。",
  },
  {
    key: "closing",
    name: "结尾语",
    placement: "tail",
    group: "尾",
    hint: "整篇最后的一块。样式包作者常在这里写推荐语，不要就整块去掉。",
  },
  {
    key: "footer",
    name: "落款",
    placement: "tail",
    group: "尾",
    hint: "结尾语之后的那一行小字。",
  },
];

/** 部件 key → 元信息。 */
export const PART_META: Record<LayoutPartKey, PartMeta> = PART_CATALOG.reduce(
  (acc, meta) => {
    acc[meta.key] = meta;
    return acc;
  },
  {} as Record<LayoutPartKey, PartMeta>,
);

/* ------------------------------------------------------------------ *
 * 内置默认样式
 * ------------------------------------------------------------------ */

// 字体名用单引号：style 属性本身是双引号包裹的，字体名里再出现双引号会把属性提前截断。
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

// 代码用等宽栈，SFMono 只在 Apple 平台有，后面几级保证 Windows 落到 Consolas。
const MONO_STACK = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

/** 各层标题的字号。 */
export const HEADING_SIZES: Record<number, string> = {
  1: "22px",
  2: "19px",
  3: "17px",
  4: "16px",
};

/**
 * 某个部件的默认 HTML 模板。
 *
 * 颜色不写死，写成 {{变量名}}——所以改一个色值，全篇跟着变，
 * 而部件 html 本身可以整段替换掉（这就是"样式包"能覆盖默认样的地方）。
 *
 * 这里返回的是**模板**（带占位符），不是成品 HTML：
 * 渲染时才把 {{content}}、{{变量名}} 填上。
 */
export function defaultPartTemplate(key: LayoutPartKey): string {
  switch (key) {
    case "root":
      return `<section style="${styleText({
        "font-family": FONT_STACK,
        "font-size": "16px",
        "line-height": 1.75,
        color: "{{text}}",
        "word-break": "break-word",
      })}">{{content}}</section>`;
    case "lead":
    case "closing":
    case "footer":
    case "paragraph":
      return `<p style="${styleText({
        "font-family": FONT_STACK,
        "font-size": "16px",
        "line-height": 1.75,
        color: "{{text}}",
        margin: "0 0 16px 0",
        // 两端对齐在公众号里会拉伸中文标点间距，右边出现大片空白；
        // 左对齐配合 CJK 自然换行，视觉上反而更整齐。
        "text-align": "left",
      })}">{{content}}</p>`;
    case "title":
    case "heading":
    case "heading3":
    case "heading4":
      // 字重降到 500：公众号里标题本来就有字号优势，800 会让标题比正文加粗
      // 还重，读起来像两把一样粗的锤子。降到 500 后标题靠字号立住，
      // 正文里的加粗（600）也能和标题区分开。
      return `<{{tag}} style="${styleText({
        "font-family": FONT_STACK,
        "font-size": "{{headingSize}}",
        "font-weight": 500,
        "line-height": 1.4,
        color: "{{heading}}",
        margin: "28px 0 14px 0",
        "letter-spacing": "0.01em",
      })}">{{content}}</{{tag}}>`;
    case "strong":
      return `<strong style="${styleText({ "font-weight": 600, color: "{{heading}}" })}">{{content}}</strong>`;
    case "em":
      return `<em style="font-style: italic;">{{content}}</em>`;
    case "delete":
      return `<span style="${styleText({
        "text-decoration": "line-through",
        color: "{{muted}}",
      })}">{{content}}</span>`;
    case "inlineCode":
      return `<code style="${styleText({
        "font-family": MONO_STACK,
        "font-size": "14px",
        "background-color": "{{codeBg}}",
        color: "{{codeText}}",
        padding: "2px 5px",
        "border-radius": "3px",
      })}">{{content}}</code>`;
    case "quote":
      return `<blockquote style="${styleText({
        "font-family": FONT_STACK,
        "font-size": "15px",
        "line-height": 1.7,
        color: "{{muted}}",
        "border-left": "3px solid {{quoteBar}}",
        padding: "2px 0 2px 14px",
        margin: "0 0 16px 0",
      })}">{{content}}</blockquote>`;
    case "list":
      return `<{{tag}}{{start}} style="${styleText({
        "font-family": FONT_STACK,
        "font-size": "16px",
        "line-height": 1.75,
        color: "{{text}}",
        margin: "0 0 16px 0",
        "padding-left": "22px",
      })}">{{content}}</{{tag}}>`;
    case "listItem":
      return `<li style="margin-bottom: 6px;">{{content}}</li>`;
    case "code":
      // 代码块的"窗口"外壳：一条带三个圆点的标题条 + 代码区。
      // 用 <section> 包而不是 <div>：公众号里 section 是块级容器，比 div 稳定。
      // overflow: hidden 配 border-radius 才有圆角——只有 border-radius 的话，
      // 内部的标题条底色和代码区背景会把圆角顶穿成方角。
      return `<section style="${styleText({
        border: "1px solid {{border}}",
        "border-radius": "8px",
        "box-shadow": "{{codeShadow}}",
        overflow: "hidden",
        margin: "0 0 16px 0",
      })}"><section style="${styleText({
        "font-family": FONT_STACK,
        "font-size": "12px",
        "line-height": 1,
        padding: "8px 12px",
        "background-color": "{{codeHeader}}",
        "border-bottom": "1px solid {{border}}",
      })}">{{dots}}{{langCaption}}</section><pre style="${styleText({
        margin: 0,
        padding: "14px 16px",
        "font-family": MONO_STACK,
        "font-size": "13px",
        "line-height": 1.6,
        "background-color": "{{codeBg}}",
        color: "{{text}}",
        "overflow-x": "auto",
      })}"{{langAttr}}><code>{{content}}</code></pre></section>`;
    case "table":
      // 表格外面套一层横向滚动容器。
      // 列多的表在手机上会被撑破版式——<table> 自身不会主动收缩，
      // 所以滚动必须放在外面：外层 section 负责溢出滚动，内层 table 给个 min-width
      // 撑住单元格，让"内容不被挤压"和"页面不被撑爆"各管一件事。
      return `<section style="${styleText({
        "overflow-x": "auto",
        "max-width": "100%",
        margin: "0 0 16px 0",
      })}"><table style="${styleText({
        width: "100%",
        "min-width": "480px",
        "border-collapse": "collapse",
        "font-family": FONT_STACK,
      })}"><thead><tr style="border: 1px solid {{border}}">{{thead}}</tr></thead><tbody>{{tbody}}</tbody></table></section>`;
    case "tableHead":
      return `<th style="${styleText({
        border: "1px solid {{border}}",
        padding: "8px 10px",
        "font-size": "14px",
        "font-weight": 700,
        color: "{{heading}}",
        "background-color": "{{surface}}",
        "text-align": "left",
      })}">{{content}}</th>`;
    case "tableCell":
      return `<td style="${styleText({
        border: "1px solid {{border}}",
        padding: "8px 10px",
        "font-size": "14px",
        "line-height": 1.6,
        color: "{{text}}",
        "vertical-align": "top",
      })}">{{content}}</td>`;
    case "image":
      return `<img src="{{src}}" alt="{{alt}}" style="{{imageStyle}}" />`;
    case "divider":
      return `<hr style="${styleText({
        border: "none",
        "border-top": "1px solid {{border}}",
        margin: "24px 0",
      })}">`;
    case "link":
      return `<a href="{{href}}" style="${styleText({
        color: "#3D7BFF",
        "text-decoration": "none",
      })}">{{content}}</a>`;
  }
}

/* ------------------------------------------------------------------ *
 * 模板规范化
 * ------------------------------------------------------------------ */

/** 变量名合法形状：字母、数字、下划线。 */
const VAR_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** 把变量表补齐成完整的一套（缺的用默认配色补上，多余的保留）。 */
export function normalizeVars(vars: Record<string, string> | undefined | null): Record<string, string> {
  const base = THEME_PALETTES.default;
  const out: Record<string, string> = { ...base };
  if (!vars) return out;
  for (const [key, value] of Object.entries(vars)) {
    if (!VAR_NAME.test(key)) continue;
    // 保留名（tag、href、thead…）是渲染上下文的位置，
    // 用户拿它当变量名会被上下文顶掉，所以这里直接不给留。
    if (CONTEXT_PLACEHOLDERS.has(key)) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  return out;
}

/**
 * 渲染上下文占位符。
 *
 * 这些名字是**渲染时由上下文给的**（标签名、链接地址、表头表体……），
 * 不是模板自己的色值。色值表里不该列出它们——
 * 列出来会让人以为「改一下 tag 变量的颜色」能管事。
 */
export const CONTEXT_PLACEHOLDERS = new Set([
  "content",
  "tag",
  "headingSize",
  "level",
  "start",
  "href",
  "src",
  "alt",
  "imageStyle",
  "thead",
  "tbody",
  "dots",
  "langCaption",
  "langAttr",
  "lang",
]);

/** 模板里出现的所有 {{xxx}} 占位名（不含内容与渲染上下文）。 */
export function templatePlaceholders(html: string): string[] {
  const found = new Set<string>();
  const re = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    if (CONTEXT_PLACEHOLDERS.has(match[1])) continue;
    found.add(match[1]);
  }
  return [...found];
}

/** 规范化一个部件：html 走清洗器，key 必须在目录里。 */
function normalizePart(input: unknown): LayoutPart | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const key = typeof raw.key === "string" ? (raw.key as LayoutPartKey) : undefined;
  if (!key || !PART_META[key]) return null;
  const meta = PART_META[key];
  const html = typeof raw.html === "string" ? sanitizeTemplateHtml(raw.html) : "";
  const text = typeof raw.text === "string" ? raw.text : "";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : meta.name;
  return {
    key,
    name,
    enabled: raw.enabled === undefined ? true : raw.enabled !== false,
    placement: meta.placement,
    html: html || defaultPartTemplate(key),
    text,
  };
}

/**
 * 把外部传入的东西收敛成一套能渲染的模板。
 *
 * 宽松是刻意的：样式包来自外面，写法五花八门，缺字段就补默认，
 * 多余字段就丢掉——但**不许渲染器因此崩掉**。
 */
export function normalizeLayoutTemplate(
  input: {
    id?: string;
    name?: string;
    description?: string;
    source?: LayoutTemplate["source"];
    vars?: Record<string, string>;
    /** 部件覆盖表。允许是任意形状，规范化时逐个挑能认的。 */
    parts?: unknown;
  },
  fallback: { id: string; name?: string; source?: LayoutTemplate["source"] } = { id: "layout" },
): LayoutTemplate {
  const source = input.source ?? fallback.source ?? "custom";
  const parts: LayoutPart[] = [];
  const seen = new Set<LayoutPartKey>();

  const push = (part: LayoutPart | null) => {
    if (!part || seen.has(part.key)) return;
    seen.add(part.key);
    parts.push(part);
  };

  if (Array.isArray(input.parts)) {
    for (const raw of input.parts) push(normalizePart(raw));
  } else if (input.parts && typeof input.parts === "object") {
    for (const [key, value] of Object.entries(input.parts as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        push(normalizePart({ key, ...(value as Record<string, unknown>) }));
      } else if (typeof value === "string") {
        push(normalizePart({ key, html: value }));
      }
    }
  }

  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "";
  return {
    id: fallback.id || input.id || "layout",
    name: name || fallback.name || "未命名模板",
    description: typeof input.description === "string" ? input.description.trim() : "",
    source,
    vars: normalizeVars(input.vars),
    parts,
  };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 渲染上下文：随元素变化的值，比如标题层级、代码语言、图片地址。 */
export type PartContext = Record<string, string>;

/**
 * 填模板。
 *
 * 顺序有讲究：先填变量与上下文，最后填 {{content}}。
 * 这样正文里万一出现 "{{text}}" 这种字样，它会原样留在正文里，
 * 不会被当成变量替换掉。
 *
 * 两类占位值的转义责任不一样：
 *
 * - **ctx**（地址、alt、拼好的 html）由调用方负责转义，稿台不重复转义——
 *   重复转义会把 `&amp;` 变成 `&amp;amp;`，链接直接坏掉。
 * - **vars**（模板自己的色值等）没人替它转义：模板可能是从外部样式包导进来的，
 *   一个带引号的色值就能把 style 属性提前截断。这里补一次转义。
 */
export function fillTemplate(
  html: string,
  vars: Record<string, string>,
  ctx: PartContext,
  content: string,
): string {
  let out = html.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (whole, key: string) => {
    if (key === "content") return whole;
    const fromCtx = ctx[key];
    if (typeof fromCtx === "string") return fromCtx;
    const fromVars = vars[key];
    return typeof fromVars === "string" ? escapeHtml(fromVars) : "";
  });
  // 用函数形式替换：正文里出现 $& 之类的东西不会被当成替换模式。
  out = out.replace(/\{\{content\}\}/g, () => content);
  return out;
}

/**
 * 渲染一个部件。
 *
 * 模板里没写这个部件，或者写了但关掉了，就退回内置默认样式——
 * 内容永远不丢。样式包缺一个部件不代表整篇排不出来。
 */
export function renderPart(
  template: LayoutTemplate,
  key: LayoutPartKey,
  content: string,
  ctx: PartContext = {},
): string {
  const part = template.parts.find(item => item.key === key);
  const html = part && part.enabled ? part.html || defaultPartTemplate(key) : defaultPartTemplate(key);
  return fillTemplate(html, template.vars, ctx, content);
}

/**
 * 渲染落位在整篇头尾的部件。
 *
 * 只有模板里写了、而且是启用状态的部件才会出现在这里。
 * 样式包里作者自己加的结尾语，不要就把它从包里剔掉——部件不在列表里，整块就没有。
 */
export function renderPlacement(template: LayoutTemplate, placement: "head" | "tail"): string {
  const out: string[] = [];
  for (const part of template.parts) {
    if (part.placement !== placement) continue;
    if (!part.enabled) continue;
    const text = part.text ?? "";
    if (!text.trim()) continue;
    // 固定文本是纯文本：样式包是外部来的，包作者写什么就渲染什么，
    // 等于给预览开了一个任意 HTML 的口子。要放标记就写在部件的 html 里。
    out.push(renderPart(template, part.key, escapeHtml(text), {}));
  }
  return out.join("");
}

/* ------------------------------------------------------------------ *
 * 清洗
 * ------------------------------------------------------------------ */

/** 允许出现在样式包里的标签。 */
const ALLOWED_TAGS = new Set([
  "section",
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "span",
  "a",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "br",
  "hr",
]);

/** 允许出现在特定标签上的属性（style 单独处理）。 */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  img: new Set(["src", "alt", "width", "height"]),
  ol: new Set(["start"]),
  a: new Set(["href"]),  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  pre: new Set(["data-language"]),
  code: new Set(["data-language"]),
};

/** 样式值里除占位符以外允许出现的字符。 */
const STYLE_VALUE_CHARS = /^[\w\s#%.,()/+*-]*$/;

/**
 * 样式值清洗。
 *
 * 只留「属性名: 值」这种形状，值里不许出现引号、尖括号、反斜杠，
 * 也不许出现 url( / expression / javascript: ——样式里能塞进外链，
 * 塞进去就等于把稿台变成任意内容执行器。
 *
 * `{{变量}}` 是唯一的例外：模板变量是稿台自己的东西（来自模板的 vars），
 * 不是外部输入，不该因为带大括号就被整条丢掉。
 * 丢掉的话，样式包里写的 `color:{{text}}` 会变成一条没有颜色的段落——
 * 「改一个色值全篇跟着变」在导入的包里就不成立，而且**不报错**，
 * 只是样式悄悄没了。占位符的名字限死在字母数字下划线，
 * 插不进分号和引号，逃不出去。
 */
function sanitizeStyle(value: string): string {
  const declarations: string[] = [];
  for (const piece of value.split(";")) {
    const index = piece.indexOf(":");
    if (index < 0) continue;
    const prop = piece.slice(0, index).trim().toLowerCase();
    const val = piece.slice(index + 1).trim();
    if (!/^[a-z-]{1,40}$/.test(prop)) continue;
    if (!val) continue;
    if (/[<>"'\\]/.test(val)) continue;
    if (/url\s*\(|expression|javascript:|@import/i.test(val)) continue;
    // 占位符摘出来单独放行：占位符之间的每一段各自过一遍白名单。
    const segments: string[] = [];
    const placeholder = /\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g;
    let cursor = 0;
    let ok = true;
    let match: RegExpExecArray | null;
    while ((match = placeholder.exec(val))) {
      const before = val.slice(cursor, match.index);
      if (!STYLE_VALUE_CHARS.test(before)) {
        ok = false;
        break;
      }
      segments.push(before, match[0]);
      // 用正则自己的 lastIndex：match.lastIndex 不是 RegExpExecArray 的属性，
      // 取到的是 undefined，cursor 一旦变 undefined，
      // val.slice(undefined) 会把整段原样取回来，后面那道白名单就永远过不去。
      cursor = placeholder.lastIndex;
    }
    if (!ok) continue;
    const tail = val.slice(cursor);
    if (!STYLE_VALUE_CHARS.test(tail)) continue;
    segments.push(tail);
    declarations.push(`${prop}: ${segments.join("")}`);
  }
  return declarations.join("; ");
}

/** 图片地址只认 http(s)、本机图片接口与 data:image。 */
function isSafeImageSrc(value: string): boolean {
  const src = value.trim();
  if (/^https?:\/\//i.test(src)) return true;
  if (src.startsWith("/api/files/img/")) return true;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(src)) return true;
  return false;
}

/**
 * 允许出现在**标签名位置**的占位符。
 *
 * 部件模板需要知道「这里放什么标签」——标题是 h1~h4、列表是 ul/ol。
 * 稿台自己的默认模板用 `{{tag}}` 表达这件事，导入的样式包自然也会这么写。
 *
 * 之前清洗器只认字母数字开头的标签名，`{{tag}}` 整段匹配不上标签，
 * 于是**整段 html 被当成纯文本转义**——导入明明「成功」，预览里却是一堆
 * 字面量标签。这类失败最难发现，所以这里明确放行。
 *
 * 只放行 `{{tag}}` 这一个名字：它渲染时会被替换成渲染上下文给的
 * h1~h4 / ul / ol，不是外部输入，插不进任何东西。
 */
const PLACEHOLDER_TAG_NAMES = new Set(["{{tag}}"]);

/** 属性清洗：白名单标签 + 白名单属性 + 样式值清洗。 */
function sanitizeAttrs(tag: string, raw: string): string {
  const out: string[] = [];
  const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name === "style") {
      const style = sanitizeStyle(value);
      if (style) out.push(` style="${escapeHtml(style)}"`);
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag];
    if (!allowed || !allowed.has(name)) continue;
    if (name === "src") {
      // `{{src}}` 是渲染占位符，不是外部地址——模板不知道图从哪来，图是渲染时
      // 才填进去的。之前这里只放行真实 URL，导入的样式包 `<img src="{{src}}">`
      // 会被整条丢掉，结果所有导入模板的图片都是空图（真机上表现为「有留白、
      // 没图」）。现在只放行这一个占位符，其余仍走 URL 白名单。
      if (value === "{{src}}") {
        out.push(` src="{{src}}"`);
        continue;
      }
      if (!isSafeImageSrc(value)) continue;
      out.push(` src="${escapeHtml(value)}"`);
      continue;
    }
    if (name === "href") {
      // 链接地址只认 http(s)，另外放行 {{href}} 这类渲染占位符——
      // 模板里写死一个地址没有意义，地址是渲染时才知道的。
      if (!isSafeHref(value)) continue;
      out.push(` href="${escapeHtml(value)}"`);
      continue;
    }
    out.push(` ${name}="${escapeHtml(value)}"`);
  }
  return out.join("");
}

/**
 * 链接地址是否安全。
 *
 * 放行两类：
 * 1. `{{xxx}}` —— 渲染占位符，渲染时会被替换成上下文里的地址（稿台自己给的）。
 * 2. http(s) 开头 —— 其余协议（javascript:、data:、file:…）一律不算。
 */
function isSafeHref(value: string): boolean {
  const raw = value.trim();
  if (/^\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}$/.test(raw)) return true;
  return /^https?:\/\//i.test(raw);
}

/**
 * 清洗样式包里的 HTML。
 *
 * 样式包是外部来的，html 片段等于外部输入：白名单之外的标签直接丢掉，
 * 属性只留白名单里的，文本片段统一转义。
 * 不在白名单里的标签**丢标签、留内容**——样式包里多写一个 <div> 不该让整段文字消失。
 */
export function sanitizeTemplateHtml(html: string): string {
  let out = "";
  let index = 0;
  // 标签名允许普通标签与受控占位符（{{tag}}）。
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*|\{\{tag\}\})((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    out += escapeHtml(html.slice(index, match.index));
    index = match.index + match[0].length;
    const closing = match[1] === "/";
    const rawTag = match[2];
    const tag = rawTag.toLowerCase();
    const isPlaceholderTag = PLACEHOLDER_TAG_NAMES.has(rawTag);
    if (!isPlaceholderTag && !ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      out += `</${rawTag}>`;
      continue;
    }
    // 占位标签名按通用标签处理：属性只认白名单里的（style 单独走清洗），
    // 标签名本身留成 {{tag}}，渲染时再被替换成真正的 h1~h4 / ul / ol。
    const attrs = sanitizeAttrs(isPlaceholderTag ? "" : tag, match[3] ?? "");
    out += `<${rawTag}${attrs}${match[4] === "/" ? " /" : ""}>`;
  }
  out += escapeHtml(html.slice(index));
  return out;
}

/* ------------------------------------------------------------------ *
 * 样式包导入
 * ------------------------------------------------------------------ */

export type LayoutPack = {
  id?: string;
  name?: string;
  description?: string;
  vars?: Record<string, string>;
  /**
   * 部件。两种写法都收：
   * - 对象：{ "paragraph": { "html": "..." } }
   * - 数组：[{ "key": "paragraph", "html": "..." }]
   */
  parts?: Record<string, unknown> | unknown[];
};

/** 样式包解析的结果。 */
export type LayoutPackParse = {
  template: LayoutTemplate;
  /** 解析过程中的提醒：哪些部件被跳过了、哪些变量没认出来。 */
  warnings: string[];
};

/**
 * 解析一个样式包。
 *
 * 包的形状故意宽松：外部样式包五花八门，有的把 vars 写成颜色表，
 * 有的直接给整套 html。只要能认出"哪几个部件长什么样"，其余缺的就补默认。
 */
export function parseLayoutPack(text: string, fallbackId = "imported"): LayoutPackParse {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("样式包不是合法的 JSON。");
  }
  if (!raw || typeof raw !== "object") throw new Error("样式包的内容不是一个对象。");

  const pack = raw as LayoutPack;
  const partsInput: unknown[] = [];

  if (Array.isArray(pack.parts)) {
    partsInput.push(...pack.parts);
  } else if (pack.parts && typeof pack.parts === "object") {
    for (const [key, value] of Object.entries(pack.parts)) {
      if (value && typeof value === "object") {
        partsInput.push({ key, ...(value as Record<string, unknown>) });
      } else if (typeof value === "string") {
        partsInput.push({ key, html: value });
      }
    }
  }

  const unknownKeys = partsInput
    .map(item => (item as Record<string, unknown>)?.key)
    .filter(key => typeof key === "string" && !PART_META[key as LayoutPartKey]);

  if (unknownKeys.length) {
    warnings.push(`样式包里有 ${unknownKeys.length} 个部件稿台不认识，已忽略：${unknownKeys.join("、")}`);
  }

  const template = normalizeLayoutTemplate(
    {
      name: typeof pack.name === "string" ? pack.name : "",
      description: typeof pack.description === "string" ? pack.description : "",
      source: "imported",
      vars: pack.vars && typeof pack.vars === "object" ? (pack.vars as Record<string, string>) : {},
      parts: partsInput,
    },
    { id: fallbackId, name: "导入的模板", source: "imported" },
  );

  if (!template.parts.length) {
    warnings.push("样式包里没认出任何可用部件，导入后会退回内置默认样式。");
  }

  return { template, warnings };
}

/* ------------------------------------------------------------------ *
 * 内置模板
 * ------------------------------------------------------------------ */

const builtinCache = new Map<ThemeId, LayoutTemplate>();

/**
 * 内置模板。
 *
 * 它只有一套色值、没有任何部件覆盖——所有部件都走默认样式，
 * 而默认样式里的颜色取自这套色值。所以"换配色"就是换一套 vars，
 * "改结构"才需要写部件。
 */
export function builtinTemplate(themeId: ThemeId): LayoutTemplate {
  const cached = builtinCache.get(themeId);
  if (cached) return cached;
  const palette = THEME_PALETTES[themeId] ?? THEME_PALETTES.default;
  const template: LayoutTemplate = {
    id: `builtin:${themeId}`,
    name: THEME_NAMES[themeId] ?? THEME_NAMES.default,
    description: `内置配色：${THEME_NAMES[themeId] ?? THEME_NAMES.default}`,
    source: "builtin",
    vars: { ...palette },
    parts: [],
  };
  builtinCache.set(themeId, template);
  return template;
}

/** 内置模板 id 形如 builtin:paper。 */
export function builtinTemplateId(themeId: ThemeId): string {
  return `builtin:${themeId}`;
}

/** 判断一个模板 id 是不是内置模板。 */
export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith("builtin:");
}

/** 从内置模板 id 里取回配色；不是内置 id 就返回 null。 */
export function themeIdFromBuiltinId(id: string): ThemeId | null {
  const raw = id.startsWith("builtin:") ? id.slice("builtin:".length) : "";
  return raw === "default" || raw === "paper" || raw === "mist" ? raw : null;
}

/* ------------------------------------------------------------------ *
 * 长文排版主题
 * ------------------------------------------------------------------ */

/**
 * 长文主题标识。
 *
 * 现有 3 套配色（default/paper/mist）之外，新增 8 套长文主题。
 * 注意：已有 paper，为避免冲突，新增的 8 套里与现有重名的改名为 long-paper。
 */
export type LongArticleThemeId =
  | "github"
  | "wechat"
  | "serif"
  | "long-paper"
  | "grid"
  | "typo"
  | "media"
  | "colorful";

/**
 * 一套长文主题的排版配置。
 *
 * 与 ThemePalette 的区别：长文主题管的是**结构节奏**（行距、段距、标题样式、
 * 引用样式、表头底色），而不是单一色值表。每个字段是一段可内联的样式片段，
 * 由 getLongArticleThemeStyle 按标签名拼装。
 */
export type LongArticleThemeStyle = {
  /** 中文名，界面上显示。 */
  name: string;
  /** 正文行高。 */
  lineHeight: string;
  /** 段落间距（margin-bottom）。 */
  paragraphGap: string;
  /** 一级标题内联样式（不含 content 占位）。 */
  h1: string;
  /** 二级标题内联样式。 */
  h2: string;
  /** 三级标题内联样式。 */
  h3: string;
  /** 四级标题内联样式。 */
  h4: string;
  /** 引用块内联样式。 */
  blockquote: string;
  /** 行内代码内联样式。 */
  code: string;
  /** 表格表头底色。 */
  tableHeaderBg: string;
};

/** 长文主题清单（按界面展示顺序）。 */
export const LONG_ARTICLE_THEMES: Record<LongArticleThemeId, LongArticleThemeStyle> = {
  github: {
    name: "GitHub",
    lineHeight: "1.75",
    paragraphGap: "16px",
    h1: "font-size: 24px; font-weight: 600; margin: 28px 0 16px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; color: #1f2328;",
    h2: "font-size: 20px; font-weight: 600; margin: 24px 0 14px; padding-bottom: 6px; border-bottom: 1px solid #eaeef2; color: #1f2328;",
    h3: "font-size: 17px; font-weight: 600; margin: 20px 0 12px; color: #1f2328;",
    h4: "font-size: 15px; font-weight: 600; margin: 16px 0 10px; color: #1f2328;",
    blockquote: "margin: 0 0 16px; padding: 2px 0 2px 16px; border-left: 4px solid #d0d7de; color: #59636e; font-size: 15px;",
    code: "font-size: 13px; background: #f6f8fa; color: #c7254e; padding: 2px 5px; border-radius: 4px;",
    tableHeaderBg: "#f6f8fa",
  },
  wechat: {
    name: "公众号风",
    lineHeight: "1.75",
    paragraphGap: "16px",
    h1: "font-size: 22px; font-weight: 500; margin: 28px 0 14px; color: #1a1a1a; letter-spacing: 0.01em;",
    h2: "font-size: 19px; font-weight: 500; margin: 24px 0 12px; color: #1a1a1a; letter-spacing: 0.01em;",
    h3: "font-size: 17px; font-weight: 500; margin: 20px 0 10px; color: #1a1a1a;",
    h4: "font-size: 16px; font-weight: 500; margin: 16px 0 8px; color: #1a1a1a;",
    blockquote: "margin: 0 0 16px; padding: 2px 0 2px 14px; border-left: 3px solid #d9d9d9; color: #767676; font-size: 15px;",
    code: "font-size: 14px; background: #f5f5f5; color: #c7254e; padding: 2px 5px; border-radius: 3px;",
    tableHeaderBg: "#ffffff",
  },
  serif: {
    name: "衬线书卷",
    lineHeight: "1.9",
    paragraphGap: "20px",
    h1: "font-size: 24px; font-weight: 700; margin: 32px 0 18px; color: #241c14; font-family: Georgia, 'Songti SC', 'Noto Serif SC', 'SimSun', serif;",
    h2: "font-size: 21px; font-weight: 700; margin: 28px 0 16px; color: #241c14; font-family: Georgia, 'Songti SC', 'Noto Serif SC', 'SimSun', serif;",
    h3: "font-size: 18px; font-weight: 700; margin: 24px 0 12px; color: #241c14; font-family: Georgia, 'Songti SC', 'Noto Serif SC', 'SimSun', serif;",
    h4: "font-size: 16px; font-weight: 700; margin: 20px 0 10px; color: #241c14; font-family: Georgia, 'Songti SC', 'Noto Serif SC', 'SimSun', serif;",
    blockquote: "margin: 0 0 20px; padding: 14px 18px; border-left: 3px solid #c9b18a; color: #7d6e5d; font-size: 15px; font-style: italic; background: #faf6ef;",
    code: "font-size: 13px; background: #f2ead9; color: #9a5b33; padding: 2px 5px; border-radius: 3px; font-family: 'SFMono-Regular', Consolas, monospace;",
    tableHeaderBg: "#faf6ef",
  },
  "long-paper": {
    name: "暖纸阅读",
    lineHeight: "1.85",
    paragraphGap: "18px",
    h1: "font-size: 23px; font-weight: 600; margin: 30px 0 16px; color: #241c14;",
    h2: "font-size: 20px; font-weight: 600; margin: 26px 0 14px; color: #241c14;",
    h3: "font-size: 17px; font-weight: 600; margin: 22px 0 12px; color: #241c14;",
    h4: "font-size: 15px; font-weight: 600; margin: 18px 0 10px; color: #241c14;",
    blockquote: "margin: 0 0 18px; padding: 12px 16px; border-left: 4px solid #c9b18a; color: #7d6e5d; font-size: 15px; background: #fdfaf3; border-radius: 0 6px 6px 0;",
    code: "font-size: 13px; background: #f2ead9; color: #9a5b33; padding: 2px 5px; border-radius: 3px;",
    tableHeaderBg: "#fdfaf3",
  },
  grid: {
    name: "网格秩序",
    lineHeight: "1.7",
    paragraphGap: "14px",
    h1: "font-size: 22px; font-weight: 700; margin: 28px 0 14px; color: #17222b; letter-spacing: 0.02em;",
    h2: "font-size: 19px; font-weight: 700; margin: 24px 0 12px; color: #17222b; letter-spacing: 0.02em;",
    h3: "font-size: 17px; font-weight: 700; margin: 20px 0 10px; color: #17222b;",
    h4: "font-size: 15px; font-weight: 700; margin: 16px 0 8px; color: #17222b;",
    blockquote: "margin: 0 0 14px; padding: 10px 14px; border-left: 4px solid #9fb9cb; color: #63727f; font-size: 15px; background: #f4f7fa;",
    code: "font-size: 13px; background: #eef2f5; color: #38627f; padding: 2px 5px; border-radius: 2px; font-family: 'SFMono-Regular', Consolas, monospace;",
    tableHeaderBg: "#eef2f5",
  },
  typo: {
    name: "杂志排版",
    lineHeight: "1.8",
    paragraphGap: "22px",
    h1: "font-size: 26px; font-weight: 800; margin: 34px 0 20px; color: #1a1a1a; letter-spacing: -0.01em;",
    h2: "font-size: 21px; font-weight: 800; margin: 30px 0 16px; color: #1a1a1a; letter-spacing: -0.01em;",
    h3: "font-size: 18px; font-weight: 700; margin: 26px 0 12px; color: #1a1a1a;",
    h4: "font-size: 16px; font-weight: 700; margin: 22px 0 10px; color: #1a1a1a;",
    blockquote: "margin: 0 0 22px; padding: 16px 20px; border-left: 4px solid #3D7BFF; color: #333333; font-size: 16px; font-style: italic; background: #f0f5ff; border-radius: 0 8px 8px 0;",
    code: "font-size: 13px; background: #f5f5f5; color: #c7254e; padding: 2px 6px; border-radius: 3px; font-family: 'SFMono-Regular', Consolas, monospace;",
    tableHeaderBg: "#f0f0f0",
  },
  media: {
    name: "图片优先",
    lineHeight: "1.75",
    paragraphGap: "18px",
    h1: "font-size: 24px; font-weight: 700; margin: 30px 0 16px; color: #1f2937;",
    h2: "font-size: 20px; font-weight: 700; margin: 26px 0 14px; color: #1f2937;",
    h3: "font-size: 17px; font-weight: 700; margin: 22px 0 12px; color: #1f2937;",
    h4: "font-size: 15px; font-weight: 700; margin: 18px 0 10px; color: #1f2937;",
    blockquote: "margin: 0 0 18px; padding: 12px 16px; border-left: 4px solid #ef4444; color: #6b7280; font-size: 15px; background: #fef2f2; border-radius: 0 6px 6px 0;",
    code: "font-size: 13px; background: #f6f8fa; color: #c7254e; padding: 2px 5px; border-radius: 4px;",
    tableHeaderBg: "#f6f8fa",
  },
  colorful: {
    name: "多彩标题",
    lineHeight: "1.8",
    paragraphGap: "18px",
    h1: "font-size: 23px; font-weight: 700; margin: 30px 0 16px; color: #b45309; padding-bottom: 8px; border-bottom: 3px solid #f59e0b;",
    h2: "font-size: 20px; font-weight: 700; margin: 26px 0 14px; color: #1d4ed8; padding-left: 10px; border-left: 4px solid #2563eb;",
    h3: "font-size: 17px; font-weight: 700; margin: 22px 0 12px; color: #15803d; padding-left: 9px; border-left: 3px solid #22c55e;",
    h4: "font-size: 15px; font-weight: 700; margin: 18px 0 10px; color: #7c3aed;",
    blockquote: "margin: 0 0 18px; padding: 12px 16px; border-left: 4px solid #2563eb; color: #475569; font-size: 15px; background: #eff6ff; border-radius: 0 6px 6px 0;",
    code: "font-size: 13px; background: #f6f8fa; color: #c7254e; padding: 2px 5px; border-radius: 4px;",
    tableHeaderBg: "#e0f2fe",
  },
};

/** 长文主题 id 列表（不含内置 3 套配色）。 */
export const LONG_ARTICLE_THEME_IDS: LongArticleThemeId[] = [
  "github",
  "wechat",
  "serif",
  "long-paper",
  "grid",
  "typo",
  "media",
  "colorful",
];

/** 长文主题 id → 中文名（界面展示用）。 */
export const LONG_ARTICLE_THEME_NAMES: Record<LongArticleThemeId, string> = Object.fromEntries(
  LONG_ARTICLE_THEME_IDS.map(id => [id, LONG_ARTICLE_THEMES[id].name]),
) as Record<LongArticleThemeId, string>;

/** 取一套长文主题；未知 id 回落默认 github。 */
export function getLongArticleTheme(id: string): LongArticleThemeStyle {
  return LONG_ARTICLE_THEMES[id as LongArticleThemeId] ?? LONG_ARTICLE_THEMES.github;
}

/** 长文主题里能按标签名取样式的标签。 */
const LONG_ARTICLE_STYLED_TAGS = new Set(["h1", "h2", "h3", "h4", "blockquote", "code"]);

/**
 * 按标签名返回长文主题的内联样式字符串。
 *
 * 段落（p）、标题用 lineHeight / paragraphGap 拼基础节奏；
 * 标题再叠加该主题的专属样式；引用、代码取主题样式。
 * 不认识的标签返回空字符串（渲染器走自己的默认样式）。
 */
export function getLongArticleThemeStyle(tagName: string, themeId: string): string {
  const theme = getLongArticleTheme(themeId);
  const tag = tagName.toLowerCase();
  if (!LONG_ARTICLE_STYLED_TAGS.has(tag)) return "";

  const base = `line-height: ${theme.lineHeight};`;
  if (tag === "p") return `${base} margin: 0 0 ${theme.paragraphGap};`;
  if (tag === "h1") return theme.h1;
  if (tag === "h2") return theme.h2;
  if (tag === "h3") return theme.h3;
  if (tag === "h4") return theme.h4;
  if (tag === "blockquote") return theme.blockquote;
  if (tag === "code") return theme.code;
  return "";
}
