import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Root, RootContent, Table } from "mdast";
import { codeBlockText, escapeHtml, styleText } from "./html-util";
import {
  builtinTemplate,
  defaultPartTemplate,
  fillTemplate,
  HEADING_SIZES,
  renderPart,
  renderPlacement,
  type LayoutTemplate,
} from "./layout-template";
import { normalizeThemeId, type ThemeId } from "./wx-theme";

/**
 * Markdown → 公众号兼容 HTML。
 *
 * 公众号编辑器只接受一套受限的 HTML：不能有 class、不能挂外链样式表，
 * 只能用行内 style。所以这里不走通用的 mdast-to-html，而是自己遍历语法树，
 * 把每个节点映射成带行内样式的标签。
 *
 * **样式从哪来**：不在这个文件里写死，而是去「排版模板」里取部件。
 * 每个部件是一段 HTML 模板，模板里没有的部件走内置默认样式，
 * 默认样式里的颜色又取自模板的色值表。所以换配色换模板、改结构改部件，
 * 两件事互不干扰。
 *
 * 安全底线：所有文本节点都要转义。素材是用户丢进来的任意文本，
 * 而渲染结果会被塞进 iframe 预览，也会被复制进公众号——不转义等于把
 * 用户的素材变成可执行脚本。
 */

// 主题本身在 wx-theme.ts（客户端组件也要用），这里转出去一份，
// 免得每个引用处都改一遍 import 路径。
export { THEME_NAMES, normalizeThemeId } from "./wx-theme";
export type { ThemeId } from "./wx-theme";
export { escapeHtml } from "./html-util";

export type WechatRenderOptions = {
  /** 配色主题。没给模板时用它挑内置模板。 */
  theme?: ThemeId;
  /** 是否给图片加装饰（居中、圆角）。 */
  decorateImages?: boolean;
  /** 排版模板。给了它就按它排，theme 忽略。 */
  template?: LayoutTemplate;
};

// 代码用等宽栈，SFMono 只在 Apple 平台有，后面几级保证 Windows 落到 Consolas。
const MONO_STACK = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

/**
 * 只有 http(s) 链接才配得上一个可点击的 <a>。
 *
 * 公众号把渲染结果当可信 HTML 处理，`javascript:` 协议一旦被写成 href，
 * 在预览区里就是"点一下即执行"。这里的判定只看前缀：data:、mailto:、
 * 相对路径、以及各种奇怪协议一律降级成纯文本，宁可不给链接也不留执行面。
 * 大小写不敏感——`JAVASCRIPT:` 同样要拦。
 */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * mdast 节点遍历。
 *
 * 用一个栈式渲染，避免递归里反复拼接大字符串。
 */
function renderNodes(
  nodes: readonly RootContent[],
  template: LayoutTemplate,
  options: WechatRenderOptions,
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": {
        out += escapeHtml(node.value);
        break;
      }
      case "heading": {
        const level = Math.min(Math.max(node.depth, 1), 4);
        const inner = renderNodes(node.children, template, options);
        // 一级标题算「主标题」，其余按层级各算各的——
        // 主题给二三四级标题配的样式往往差很多（字号、边框、斜体、大写），
        // 全塞进一个「小标题」部件会把层次抹平。
        const key = level === 1 ? "title" : level === 2 ? "heading" : level === 3 ? "heading3" : "heading4";
        out += renderPart(template, key, inner, {
          tag: `h${level}`,
          headingSize: HEADING_SIZES[level] ?? "16px",
          level: String(level),
        });
        break;
      }
      case "paragraph": {
        const inner = renderNodes(node.children, template, options);
        if (!inner.trim()) break;
        out += renderPart(template, "paragraph", inner, {});
        break;
      }
      case "strong": {
        out += renderPart(template, "strong", renderNodes(node.children, template, options), {});
        break;
      }
      case "emphasis": {
        out += renderPart(template, "em", renderNodes(node.children, template, options), {});
        break;
      }
      case "delete": {
        out += renderPart(template, "delete", renderNodes(node.children, template, options), {});
        break;
      }
      case "inlineCode": {
        out += renderPart(template, "inlineCode", escapeHtml(node.value), {});
        break;
      }
      case "code": {
        out += renderCodeBlock(node, template);
        break;
      }
      case "blockquote": {
        out += renderPart(template, "quote", renderNodes(node.children, template, options), {});
        break;
      }
      case "list": {
        const ordered = node.ordered === true;
        const tag = ordered ? "ol" : "ul";
        const start =
          ordered && node.start !== null && node.start !== undefined && node.start !== 1
            ? ` start="${node.start}"`
            : "";
        out += renderPart(template, "list", renderNodes(node.children, template, options), {
          tag,
          start,
        });
        break;
      }
      case "listItem": {
        const inner = renderNodes(node.children, template, options);
        // 列表项里的段落自带 margin，会撑出空隙，压缩掉。
        out += renderPart(
          template,
          "listItem",
          inner.replace(/<p style="[^"]*">/g, "<p>").replace(/<\/p>/g, "</p>"),
          {},
        );
        break;
      }
      case "thematicBreak": {
        out += renderPart(template, "divider", "", {});
        break;
      }
      case "link": {
        const inner = renderNodes(node.children, template, options);
        if (isWebUrl(node.url)) {
          out += renderPart(template, "link", inner, { href: escapeHtml(node.url) });
        } else {
          // 非 http(s) 协议降级成纯文本：只保留链接文字，不带 href，
          // 这样即便平台宽松解析也不会留下可执行的地址。
          out += inner;
        }
        break;
      }
      case "image": {
        const imageStyle = options.decorateImages
          ? styleText({
              "max-width": "100%",
              display: "block",
              margin: "0 auto",
              "border-radius": "4px",
            })
          : styleText({ "max-width": "100%", display: "block", margin: "0 auto" });
        out += renderPart(template, "image", "", {
          src: escapeHtml(node.url),
          alt: escapeHtml(node.alt ?? ""),
          imageStyle,
        });
        break;
      }
      case "break": {
        out += "<br />";
        break;
      }
      case "table": {
        out += renderTable(node as Table, template, options);
        break;
      }
      case "tableRow": {
        const inner = renderNodes(node.children, template, options);
        out += `<tr style="${styleText({ border: `1px solid ${template.vars.border}` })}">${inner}</tr>`;
        break;
      }
      case "tableCell": {
        const inner = renderNodes(node.children, template, options);
        out += renderPart(template, "tableCell", inner, {});
        break;
      }
      case "html": {
        // 原始 HTML 一律不原样透传：素材里可能带脚本。
        out += escapeHtml(node.value);
        break;
      }
      default: {
        if ("children" in node && Array.isArray(node.children)) {
          out += renderNodes(node.children as RootContent[], template, options);
        }
        break;
      }
    }
  }
  return out;
}

/**
 * 代码块。
 *
 * 顶栏的三个圆点用模板变量里的 dot1..dot3 上色，
 * 语言名有值才出现——没写语言的时候标题条只剩三个点，不留一个空标签。
 */
function renderCodeBlock(
  node: Extract<RootContent, { type: "code" }>,
  template: LayoutTemplate,
): string {
  const vars = template.vars;
  const lang = node.lang ? escapeHtml(node.lang) : "";
  const dots = [vars.dot1, vars.dot2, vars.dot3]
    .map(
      color =>
        `<span style="${styleText({
          display: "inline-block",
          width: "12px",
          height: "12px",
          "border-radius": "50%",
          "background-color": color,
          margin: "0 6px 0 0",
        })}"></span>`,
    )
    .join("");
  const caption = lang
    ? `<span style="${styleText({
        "font-family": MONO_STACK,
        "font-size": "12px",
        color: vars.muted,
        margin: "0 0 0 8px",
      })}">${lang}</span>`
    : "";
  return renderPart(template, "code", codeBlockText(node.value), {
    dots,
    langCaption: caption,
    langAttr: lang ? ` data-language="${lang}"` : "",
    lang,
  });
}

/**
 * 表格。
 *
 * 表格外面套一层横向滚动容器。
 * 列多的表在手机上会被撑破版式——<table> 自身不会主动收缩，
 * 所以滚动必须放在外面：外层 section 负责溢出滚动，内层 table 给个 min-width
 * 撑住单元格，让"内容不被挤压"和"页面不被撑爆"各管一件事。
 */
function renderTable(node: Table, template: LayoutTemplate, options: WechatRenderOptions): string {
  const rows = node.children ?? [];
  if (!rows.length) return "";
  const headRow = rows[0];
  const bodyRows = rows.slice(1);

  const thead = (headRow.children ?? [])
    .map(cell => renderPart(template, "tableHead", renderNodes(cell.children, template, options), {}))
    .join("");

  const tbody = bodyRows
    .map(row => {
      const cells = (row.children ?? [])
        .map(cell => renderPart(template, "tableCell", renderNodes(cell.children, template, options), {}))
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return renderPart(template, "table", "", { thead, tbody });
}

function parse(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
}

/** 把 Markdown 渲染成公众号可粘贴的 HTML。 */
export function markdownToWechatHtml(markdown: string, options: WechatRenderOptions = {}): string {
  // 没给模板就用内置配色模板：它的部件表是空的，
  // 所有部件走默认样式，颜色取自那套配色。
  const template = options.template ?? builtinTemplate(normalizeThemeId(options.theme));
  const body = renderNodes(parse(markdown).children, template, options);
  const head = renderPlacement(template, "head");
  const tail = renderPlacement(template, "tail");
  return renderPart(template, "root", head + body + tail, {});
}

/**
 * 按模板渲染一段 Markdown，产出预览用的正文。
 *
 * 给排版模板页用：那里要拿「模板 + 示例稿」的渲染结果，
 * 跟公众号预览走的是同一段代码，不能各写一套。
 */
export function renderTemplatePreview(
  markdown: string,
  template: LayoutTemplate,
  options: WechatRenderOptions = {},
): string {
  return markdownToWechatHtml(markdown, { ...options, template });
}

export { defaultPartTemplate, fillTemplate };

/** 去掉 markdown 标记符号，得到纯文本。 */
function stripMarks(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .trim();
}

/** 取标题：优先第一个 `#` 标题，其次第一行非空文本。 */
export function extractTitle(markdown: string): string {
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m);
  if (heading) return stripMarks(heading[1]).trim();
  const firstLine = markdown.split("\n").map(line => line.trim()).find(Boolean);
  return firstLine ? stripMarks(firstLine).trim() : "";
}

/** 取摘要：正文前若干字符的纯文本版本。 */
export function extractSummary(markdown: string, maxLength = 120): string {
  const body = markdown
    .replace(/^#{1,6}\s+.*$/gm, "")
    .trim();
  const plain = stripMarks(body).replace(/\s+/g, " ").trim();
  if (plain.length <= maxLength) return plain;
  const slice = plain.slice(0, maxLength);
  const cut = Math.max(slice.lastIndexOf("，"), slice.lastIndexOf("。"), slice.lastIndexOf(" "));
  const base = cut > maxLength * 0.6 ? slice.slice(0, cut) : slice;
  return `${base.trim()}…`;
}

/**
 * 把整篇 Markdown 摊成纯文本，段落之间空一行。
 *
 * 给「复制排版正文」用：剪贴板里同时写 html 和纯文本两份，
 * 贴到公众号编辑器走 html 那份，贴到纯文本编辑器走这份。
 * 纯文本这份要保留段落分段——全挤成一段，读者看着是一坨。
 *
 * **行内代码的内容要留着。** 摘要那套 stripMarks 会把 `` `代码` `` 整段删掉
 * （摘要把标记去掉就够了），但复制正文删的是内容：读者在公众号里
 * 看不到 `npm install`，那这句话就没了。
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 取正文里第一张图片的地址。 */
export function extractFirstImage(markdown: string): string | null {
  const hit = markdown.match(/!\[[^\]]*\]\(([^)\s]+)/);
  return hit ? hit[1] : null;
}

/** 列出所有标题。 */
export function extractHeadings(markdown: string): { level: number; text: string }[] {
  const headings: { level: number; text: string }[] = [];
  for (const line of markdown.split("\n")) {
    const hit = line.match(/^(#{1,6})\s+(.+)$/);
    if (hit) headings.push({ level: hit[1].length, text: stripMarks(hit[2]).trim() });
  }
  return headings;
}
