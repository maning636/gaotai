// 把 WeDraft 的 7 套排版模板转换成稿台随包排版样式包。
//
// 上游许可：MIT（Copyright (c) 2026 pafa and WeDraft contributors）。
// 参考：docs/design/template-gallery.md §3、resources/layout-packs/rico-wechat-default.json。
//
// 用法：npx tsx scripts/convert-wedraft-templates.mts [refPath]
// 默认 refPath = .tmp/refs/WeDraft
// 幂等：重复运行会重写 resources/layout-packs/wedraft-*.json。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REF_PATH = path.resolve(ROOT, process.argv[2] ?? ".tmp/refs/WeDraft");
const OUT_DIR = path.resolve(ROOT, "resources/layout-packs");

type CssMap = Record<string, string>;

type WedraftSource = {
  id: string;
  name: string;
  description: string;
  accentColor?: string;
  [key: string]: unknown;
};

type Palette = {
  accent: string;
  text: string;
  heading: string;
  muted: string;
  border: string;
  surface: string;
  codeBg: string;
  codeText: string;
};

const WARNINGS: Record<string, string[]> = {};

// 上游两份 JSON（default-business / next-edition）没有 description 字段，
// 用 WeDraft 文档里的风格说明兜底，避免生成 "undefined"。
const WEDRAFT_DESCRIPTION_FALLBACK: Record<string, string> = {
  "default-business": "经典暖色",
  "next-edition": "清爽绿调",
};
function warn(id: string, msg: string) {
  (WARNINGS[id] ??= []).push(msg);
}

/*
 * 样式值清洗：与 src/lib/layout-template.ts 的 sanitizeStyle 保持一致。
 * 白名单：prop 为 ^[a-z-]{1,40}$；值字符为 ^[\w\s#%.,()/+*-]*$；
 * 且不含 < > " ' \，不含 url( / expression / javascript: / @import；
 * {{变量}} 占位符可穿插在值中。
 */
const PROP_RE = /^[a-z-]{1,40}$/;
const VALUE_CHARS_RE = /^[\w\s#%.,()/+*-]*$/;
const PLACEHOLDER_RE = /\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g;

function isValueAllowed(val: string): boolean {
  if (!val) return false;
  if (/[<>"'\\]/.test(val)) return false;
  if (/url\s*\(|expression|javascript:|@import/i.test(val)) return false;
  const re = new RegExp(PLACEHOLDER_RE);
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(val))) {
    if (!VALUE_CHARS_RE.test(val.slice(cursor, m.index))) return false;
    cursor = re.lastIndex;
  }
  return VALUE_CHARS_RE.test(val.slice(cursor));
}

/** 色值 → 变量的替换顺序：先具体后通用，避免同值时挑到不相关的变量。 */
const COLOR_SUB_ORDER: Array<keyof Palette> = [
  "codeText",
  "codeBg",
  "border",
  "surface",
  "muted",
  "accent",
  "heading",
  "text",
];

function substituteColors(value: string, palette: Palette): string {
  return value.replace(/#[0-9A-Fa-f]{3,6}\b/g, (hex) => {
    const lower = hex.toLowerCase();
    for (const key of COLOR_SUB_ORDER) {
      if (palette[key].toLowerCase() === lower) return `{{${key}}}`;
    }
    return hex;
  });
}

/** 把 CSS 对象拼成内联 style 字符串，只保留白名单属性与值。 */
function buildStyle(css: CssMap, palette: Palette, id: string, partName: string): string {
  const out: string[] = [];
  for (const [prop, val] of Object.entries(css)) {
    const p = prop.trim().toLowerCase();
    if (!PROP_RE.test(p)) {
      warn(id, `${partName}: dropped "${prop}" (property name not allowed)`);
      continue;
    }
    let v = String(val).trim();
    if (!v) continue;
    v = substituteColors(v, palette);
    if (!isValueAllowed(v)) {
      warn(id, `${partName}: dropped "${p}: ${val}" (value not allowed)`);
      continue;
    }
    out.push(`${p}: ${v}`);
  }
  return out.join("; ");
}

function hexFrom(value: string | undefined): string {
  if (!value) return "";
  const m = value.match(/#[0-9A-Fa-f]{3,6}/i);
  return m ? m[0] : "";
}

/**
 * 从 WeDraft 模板推导稿台 palette：
 * - accent ← accentColor（reading 版本直接暴露；JSON 版本无该字段，取 heading2.color 作代表）
 * - text ← body.color（reading 的 article 也同值）
 * - heading ← heading2.color
 * - muted ← note.color / caption.color / referenceItem.color
 * - border ← tableCell.border-bottom 的颜色（WeDraft 的 rule 变量，最稳定出现处）
 * - surface ← tableHeaderCell 背景（若非纯白）或 tableWrapper 背景
 * - codeBg ← code 背景
 * - codeText ← code.color
 */
function derivePalette(src: WedraftSource): Palette {
  const body = (src.body as CssMap) ?? {};
  const article = (src.article as CssMap) ?? {};
  const heading2 = (src.heading2 as CssMap) ?? {};
  const note = (src.note as CssMap) ?? {};
  const caption = (src.caption as CssMap) ?? {};
  const referenceItem = (src.referenceItem as CssMap) ?? {};
  const tableCell = (src.tableCell as CssMap) ?? {};
  const tableHeaderCell = (src.tableHeaderCell as CssMap) ?? {};
  const tableWrapper = (src.tableWrapper as CssMap) ?? {};
  const code = (src.code as CssMap) ?? {};

  const accent = (src.accentColor as string) || heading2.color || "#333333";
  const text = body.color || article.color || "#333333";
  const heading = heading2.color || text;
  const muted = note.color || caption.color || referenceItem.color || "#888888";
  const border = hexFrom(tableCell["border-bottom"]) || "#dddddd";

  let surface = "";
  const thBg = tableHeaderCell["background-color"] || tableHeaderCell.background;
  if (thBg && thBg.toLowerCase() !== "#ffffff" && thBg.toLowerCase() !== "#fff") {
    surface = thBg;
  }
  if (!surface) surface = tableWrapper.background || code["background-color"] || code.background || "#f5f5f5";

  const codeBg = code["background-color"] || code.background || surface;
  const codeText = code.color || text;

  return { accent, text, heading, muted, border, surface, codeBg, codeText };
}

/**
 * 把元素的主色替换成 {{变量}}：
 * - 源里已有该颜色属性且值与变量一致 → 替换成 {{var}}；
 * - 源里没有 → 补一个 {{var}}；
 * - 源里有但值不同（罕见，JSON 版自定义色）→ 保留原值。
 */
function applyColor(css: CssMap, varName: string, varValue: string): CssMap {
  const out = { ...css };
  if (out.color) {
    if (out.color.toLowerCase() === varValue.toLowerCase()) {
      out.color = `{{${varName}}}`;
    }
  } else {
    out.color = `{{${varName}}}`;
  }
  return out;
}

/** 背景色只替换已有且匹配的属性；背景用 background 或 background-color 两种写法都收。 */
function applyBackground(css: CssMap, varName: string, varValue: string): CssMap {
  const out = { ...css };
  if (out["background-color"]) {
    if (out["background-color"].toLowerCase() === varValue.toLowerCase()) {
      out["background-color"] = `{{${varName}}}`;
    }
  } else if (out.background) {
    if (out.background.toLowerCase() === varValue.toLowerCase()) {
      out.background = `{{${varName}}}`;
    }
  }
  return out;
}

function buildPack(src: WedraftSource, displayName: string): Record<string, unknown> {
  const id = src.id;
  const palette = derivePalette(src);

  const article = (src.article as CssMap) ?? {};
  const body = (src.body as CssMap) ?? {};
  const heading2 = (src.heading2 as CssMap) ?? {};
  const heading3 = (src.heading3 as CssMap) ?? {};
  const heading4 = (src.heading4 as CssMap) ?? {};
  const paragraph = (src.paragraph as CssMap) ?? body;
  const strong = (src.strong as CssMap) ?? {};
  const em = (src.em as CssMap) ?? {};
  const link = (src.link as CssMap) ?? {};
  const code = (src.code as CssMap) ?? {};
  const quote = (src.quote as CssMap) ?? {};
  const list = (src.list as CssMap) ?? {};
  const listItem = (src.listItem as CssMap) ?? {};
  const image = (src.image as CssMap) ?? {};
  const divider = (src.divider as CssMap) ?? {};
  const tableWrapper = (src.tableWrapper as CssMap) ?? {};
  const table = (src.table as CssMap) ?? {};
  const tableHeaderCell = (src.tableHeaderCell as CssMap) ?? {};
  const tableCell = (src.tableCell as CssMap) ?? {};

  const baseReading = article && Object.keys(article).length ? article : body;

  const rootCss = applyColor(baseReading, "text", palette.text);
  const paragraphCss = applyColor(paragraph, "text", palette.text);
  const headingCss = applyColor(heading2, "heading", palette.heading);
  const heading3Css = applyColor(heading3, "accent", palette.accent);
  const heading4Css = applyColor(heading4, "accent", palette.accent);
  const strongCss = applyColor(strong, "text", palette.text);
  const linkCss = applyColor(link, "accent", palette.accent);
  const quoteCss = applyColor(quote, "text", palette.text);
  let codeCss = applyColor(code, "codeText", palette.codeText);
  codeCss = applyBackground(codeCss, "codeBg", palette.codeBg);
  const listItemCss = applyColor({ ...baseReading, ...listItem }, "text", palette.text);
  let tableHeadCss = applyColor(tableHeaderCell, "accent", palette.accent);
  tableHeadCss = applyBackground(tableHeadCss, "surface", palette.surface);
  const tableCellCss = applyColor(tableCell, "text", palette.text);

  // 稿台默认 em 用斜体，WeDraft 未定义 em
  const emCss: CssMap = { "font-style": "italic", ...em };

  // WeDraft 无 inlineCode，用默认样式；颜色与背景走变量
  const inlineCodeCss: CssMap = {
    "font-family": "Menlo, Consolas, monospace",
    "font-size": "0.9em",
    "background-color": "{{codeBg}}",
    color: "{{codeText}}",
    padding: "2px 5px",
    "border-radius": "3px",
  };

  // 表格：外层 section 负责横向滚动，table 本体样式来自上游；
  // tableWrapper 的 overflow 若已定义则保留，否则补 overflow-x: auto
  const tableWrapperCss: CssMap = {
    ...tableWrapper,
    "overflow-x": "auto",
    "max-width": "100%",
  };

  const imageCss: CssMap = { "max-width": "100%", height: "auto", ...image };

  const parts: Record<string, { html: string }> = {
    root: { html: `<section style="${buildStyle(rootCss, palette, id, "root")}">{{content}}</section>` },
    heading: {
      html: `<{{tag}} style="${buildStyle(headingCss, palette, id, "heading")}">{{content}}</{{tag}}>`,
    },
    ...(Object.keys(heading3).length
      ? {
          heading3: {
            html: `<{{tag}} style="${buildStyle(heading3Css, palette, id, "heading3")}">{{content}}</{{tag}}>`,
          },
        }
      : {}),
    ...(Object.keys(heading4).length
      ? {
          heading4: {
            html: `<{{tag}} style="${buildStyle(heading4Css, palette, id, "heading4")}">{{content}}</{{tag}}>`,
          },
        }
      : {}),
    paragraph: {
      html: `<p style="${buildStyle(paragraphCss, palette, id, "paragraph")}">{{content}}</p>`,
    },
    strong: {
      html: `<strong style="${buildStyle(strongCss, palette, id, "strong")}">{{content}}</strong>`,
    },
    em: { html: `<em style="${buildStyle(emCss, palette, id, "em")}">{{content}}</em>` },
    link: {
      html: `<a href="{{href}}" style="${buildStyle(linkCss, palette, id, "link")}">{{content}}</a>`,
    },
    inlineCode: {
      html: `<code style="${buildStyle(inlineCodeCss, palette, id, "inlineCode")}">{{content}}</code>`,
    },
    code: { html: `<pre style="${buildStyle(codeCss, palette, id, "code")}">{{content}}</pre>` },
    quote: {
      html: `<blockquote style="${buildStyle(quoteCss, palette, id, "quote")}">{{content}}</blockquote>`,
    },
    list: {
      html: `<{{tag}}{{start}} style="${buildStyle(list, palette, id, "list")}">{{content}}</{{tag}}>`,
    },
    listItem: {
      html: `<li style="${buildStyle(listItemCss, palette, id, "listItem")}">{{content}}</li>`,
    },
    table: {
      html: `<section style="${buildStyle(tableWrapperCss, palette, id, "tableWrapper")}"><table style="${buildStyle(table, palette, id, "table")}"><thead><tr>{{thead}}</tr></thead><tbody>{{tbody}}</tbody></table></section>`,
    },
    tableHead: {
      html: `<th style="${buildStyle(tableHeadCss, palette, id, "tableHead")}">{{content}}</th>`,
    },
    tableCell: {
      html: `<td style="${buildStyle(tableCellCss, palette, id, "tableCell")}">{{content}}</td>`,
    },
    image: {
      html: `<img src="{{src}}" alt="{{alt}}" style="${buildStyle(imageCss, palette, id, "image")}" />`,
    },
    divider: {
      html: `<hr style="${buildStyle(divider, palette, id, "divider")}" />`,
    },
  };

  return {
    name: `WeDraft · ${displayName}`,
    // default-business / next-edition 这两份 JSON 没有 description，
    // 直接用会写出字面量 "undefined"；用上游文档里的风格说明兜底。
    description: `${src.description?.trim() || WEDRAFT_DESCRIPTION_FALLBACK[id] || "WeDraft 模板"}\n源自 WeDraft（MIT，Copyright (c) 2026 pafa and WeDraft contributors）`,
    source: "imported",
    vars: {
      accent: palette.accent,
      text: palette.text,
      heading: palette.heading,
      muted: palette.muted,
      border: palette.border,
      surface: palette.surface,
      codeBg: palette.codeBg,
      codeText: palette.codeText,
    },
    parts,
  };
}

const READING_NAME_MAP: Record<string, string> = {
  "plain-paper": "素笺",
  "ink-journal": "墨刊",
  "jade-notes": "青岚",
  blueprint: "蓝图",
  cinnabar: "朱砂",
};

async function main() {
  if (!existsSync(REF_PATH)) {
    console.error(`参考仓库不存在：${REF_PATH}`);
    process.exit(1);
  }

  const editionsPath = path.join(REF_PATH, "templates", "reading-editions.ts");
  const m = await import(pathToFileURL(editionsPath).href);
  const readingTemplates = m.readingEditionTemplates as unknown as WedraftSource[];

  const defaultBusiness = JSON.parse(
    readFileSync(path.join(REF_PATH, "templates", "default-business.json"), "utf8"),
  ) as WedraftSource;
  const nextEdition = JSON.parse(
    readFileSync(path.join(REF_PATH, "templates", "next-edition.json"), "utf8"),
  ) as WedraftSource;

  const all: WedraftSource[] = [...readingTemplates, defaultBusiness, nextEdition];

  mkdirSync(OUT_DIR, { recursive: true });

  for (const src of all) {
    const displayName = READING_NAME_MAP[src.id] || src.name;
    const pack = buildPack(src, displayName);
    const outPath = path.join(OUT_DIR, `wedraft-${src.id}.json`);
    writeFileSync(outPath, JSON.stringify(pack, null, 2) + "\n", "utf8");
    console.log(`wrote ${path.relative(ROOT, outPath)}`);
  }

  const total = Object.values(WARNINGS).flat().length;
  console.log(`\n总 warnings: ${total}`);
  for (const [id, list] of Object.entries(WARNINGS)) {
    for (const w of list) console.log(`  - wedraft-${id}: ${w}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
