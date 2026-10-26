/**
 * 公众号排版的配色。
 *
 * 单独拆一个模块，是为了让客户端组件也能拿到配色清单和取值口径。
 * markdown.ts 那一层依赖 mdast 解析器，把整套解析器塞进浏览器包不划算；
 * 而配色这件事本身只有几个字符串，值得一个独立的小文件。
 *
 * 这三套配色是「排版模板」的内置样板：模板里每个部件的默认样式都靠这些色值渲染，
 * 所以改一处配色，全篇跟着变——三套主题共用同一套结构（段落、标题、引用、代码块、
 * 表格的 HTML 骨架一字不改），换的只是色值。
 */

/**
 * 主题标识。
 *
 * 写成可扩展的联合类型而不是裸 string：新加一套主题时编译器会列出所有
 * 取值处（渲染表、预览接口、草稿接口的回退逻辑），漏改一处就编译失败，
 * 比「运行时才知道主题拼错了」强得多。
 */
export type ThemeId = "default" | "paper" | "mist";

/** 主题中文名，给界面上的主题切换器展示用。 */
export const THEME_NAMES: Record<ThemeId, string> = {
  default: "深灰",
  paper: "暖纸",
  mist: "雾蓝",
};

/** 界面上按顺序排的主题清单。 */
export const THEME_LIST: { id: ThemeId; name: string }[] = [
  { id: "default", name: THEME_NAMES.default },
  { id: "paper", name: THEME_NAMES.paper },
  { id: "mist", name: THEME_NAMES.mist },
];

/**
 * 一套配色的全部色值。
 *
 * 字段名同时也是排版模板里的变量名：模板 html 里写 <code>{{codeBg}}</code>，
 * 渲染时用这里的值替换。所以新增一个色值只要加一个字段，
 * 所有引用 {{新字段}} 的模板立刻能用上。
 */
export type ThemePalette = {
  /** 正文主色。 */
  text: string;
  /** 标题色。 */
  heading: string;
  /** 次要文字色（引用、说明文字）。 */
  muted: string;
  /** 代码区底色。 */
  codeBg: string;
  /** 行内代码的字色。 */
  codeText: string;
  /** 分隔线与描边色。 */
  border: string;
  /** 引用左侧竖线色。 */
  quoteBar: string;
  /** 表头底色。 */
  surface: string;
  /** 代码块标题条底色：比代码区深一档，读起来才有"窗口顶栏"的分层。 */
  codeHeader: string;
  /** 代码块外阴影：刻意压得极淡，重了会在公众号里压过正文。 */
  codeShadow: string;
  /** 标题条上的三个装饰圆点。 */
  dot1: string;
  dot2: string;
  dot3: string;
};

/** 三套内置配色。 */
export const THEME_PALETTES: Record<ThemeId, ThemePalette> = {
  default: {
    text: "#333333",
    heading: "#1a1a1a",
    muted: "#767676",
    codeBg: "#f5f5f5",
    codeText: "#c7254e",
    border: "#e6e6e6",
    quoteBar: "#d9d9d9",
    surface: "#ffffff",
    codeHeader: "#ececec",
    codeShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
    dot1: "#c75a55",
    dot2: "#d2a24b",
    dot3: "#5da273",
  },
  paper: {
    text: "#3b3229",
    heading: "#241c14",
    muted: "#7d6e5d",
    codeBg: "#f2ead9",
    codeText: "#9a5b33",
    border: "#e0d5c0",
    quoteBar: "#c9b18a",
    surface: "#fdfaf3",
    codeHeader: "#eae0cc",
    codeShadow: "0 1px 3px rgba(60, 46, 30, 0.10)",
    dot1: "#b56a45",
    dot2: "#c8a155",
    dot3: "#7c8a58",
  },
  // 雾蓝：冷灰蓝底色配蓝灰正文，是三套里唯一偏冷的。
  // 代码块底色故意压得比正文白一点点，靠"差一点点"分层，而不是靠描边硬切。
  mist: {
    text: "#2c3742",
    heading: "#17222b",
    muted: "#63727f",
    codeBg: "#eef2f5",
    codeText: "#38627f",
    border: "#dbe4ea",
    quoteBar: "#9fb9cb",
    surface: "#fafcfd",
    codeHeader: "#e2e9ee",
    codeShadow: "0 1px 3px rgba(23, 34, 43, 0.10)",
    dot1: "#7fa6c4",
    dot2: "#b3c6d6",
    dot3: "#6fae9f",
  },
};

/**
 * 把外部传入的主题值收敛成合法标识。
 *
 * 来源是 URL 查询参数和请求体，都是用户可控字符串。不在白名单里的值一律
 * 回退到 default，而不是报错——预览页拼错一个参数不该让整篇预览打不开。
 */
export function normalizeThemeId(value: string | null | undefined): ThemeId {
  return value === "paper" || value === "mist" ? value : "default";
}
