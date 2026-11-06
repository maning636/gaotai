/**
 * 卡片排版主题聚合。
 *
 * 合并经典六套 + 情绪调色盘 11 套，共 17 套主题。
 * `getCardTheme(id)` 取主题（未知 id 回落默认 simple-white）；
 * `buildCardPageCss(theme)` 生成以 `.icard` 为根的 scoped CSS 字符串。
 *
 * 数据与 CSS 模板均移植自 obsidian-wechat-converter services/card-themes.js
 * （MIT 开源协议适配）。
 */

import {
  CLASSIC_CARD_THEMES,
  type CardCoverStyle,
  type CardTheme,
  type CardThemeTokens,
} from "./classic-themes";
import { MOOD_PALETTE_THEMES } from "./mood-palettes";

export type { CardTheme, CardThemeTokens, CardCoverStyle };

/** 页面宽度（px）。 */
export const CARD_PAGE_WIDTH = 375;
/** 3:4 竖版页面高度（px）。 */
export const CARD_PAGE_HEIGHT_3_4 = 500;

/** 默认主题 id：极简白。 */
export const DEFAULT_CARD_THEME_ID = "simple-white";

/** 全部主题（6 经典 + 11 mood = 17 套）。 */
export const THEMES: Record<string, CardTheme> = {
  ...CLASSIC_CARD_THEMES,
  ...MOOD_PALETTE_THEMES,
};

/** 获取主题；未知 id 返回 undefined（不回落）。 */
export function getCardTheme(id: string): CardTheme | undefined {
  return THEMES[id];
}

/** 是否为已定义主题（不回落）。 */
export function hasCardTheme(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(THEMES, id);
}

/**
 * 排版覆盖（B03）：字号/行高/边距；未提供的项回落主题 token 与固定值。
 */
export type CardTypography = {
  fontSize?: number;
  lineHeight?: number;
  pagePadding?: number;
};

/**
 * 封面变体 CSS（coverStyle 四式）。
 * - magazine（极简白）：日期页眉细线、标题组垂直居中、竖线摘要、底部居中圆点条。
 * - centered（渐变蓝/森林绿）：全居中、标题下强调色圆角短条、底部署名。
 * - luxury（黑金/玫瑰金）：双细线框、内容垂直居中、衬线标题 + 短分隔线、斜体摘要。
 * - neon（霓虹紫）：顶栏（NOTES · 日期）、右上光晕、特大标题、强调色边线摘要、底部渐变条。
 */
function buildCoverCss(theme: CardTheme): string {
  const t = theme.tokens;
  switch (theme.coverStyle) {
    case "centered":
      return `
.icard-cover--centered .icard-cover-body { align-items: center; text-align: center; }
.icard-cover--centered .icard-cover-kicker { margin-bottom: 18px; }
.icard-cover--centered .icard-cover-title {
  font-size: 25px;
  margin-top: auto;
}
.icard-cover--centered .icard-cover-title::after {
  content: "";
  display: block;
  width: 56px;
  height: 4px;
  border-radius: 999px;
  background: ${t.accentColor};
  margin: 18px auto 0;
}
.icard-cover--centered .icard-cover-excerpt {
  margin-top: 16px;
  margin-bottom: auto;
  max-width: 30em;
}
.icard-cover--centered .icard-cover-meta { margin-top: 0; letter-spacing: 1px; }
`;
    case "luxury":
      return `
.icard-cover--luxury::before,
.icard-cover--luxury::after {
  content: "";
  position: absolute;
  pointer-events: none;
}
.icard-cover--luxury::before { inset: 10px; border: 1px solid ${t.borderColor}; }
.icard-cover--luxury::after { inset: 14px; border: 1px solid ${t.borderColor}; opacity: 0.45; }
.icard-cover--luxury .icard-cover-body { align-items: center; text-align: center; }
.icard-cover--luxury .icard-cover-kicker { letter-spacing: 3px; margin-bottom: 20px; }
.icard-cover--luxury .icard-cover-title { font-size: 26px; letter-spacing: 0.5px; margin-top: auto; }
.icard-cover--luxury .icard-cover-title::after {
  content: "";
  display: block;
  width: 44px;
  height: 2px;
  background: ${t.accentColor};
  margin: 18px auto 0;
}
.icard-cover--luxury .icard-cover-excerpt {
  margin-top: 16px;
  margin-bottom: auto;
  font-style: italic;
  max-width: 30em;
}
.icard-cover--luxury .icard-cover-meta {
  margin-top: 0;
  padding-top: 14px;
  border-top: 1px solid ${t.borderColor};
  align-self: stretch;
  text-align: center;
  letter-spacing: 2px;
}
`;
    case "neon":
      return `
.icard-cover--neon::before {
  content: "";
  position: absolute;
  top: -12%;
  right: -18%;
  width: 72%;
  height: 46%;
  background: radial-gradient(closest-side, ${t.accentColor}26, transparent);
  pointer-events: none;
}
.icard-cover--neon .icard-cover-kicker {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid ${t.borderColor};
}
.icard-cover--neon .icard-cover-kicker::before {
  content: "NOTES";
  font-size: 10px;
  letter-spacing: 3px;
  color: ${t.accentColor};
}
.icard-cover--neon .icard-cover-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.3px;
  margin-top: auto;
}
.icard-cover--neon .icard-cover-excerpt {
  margin-top: 14px;
  margin-bottom: auto;
  border-left: 3px solid ${t.accentColor};
  padding-left: 12px;
}
.icard-cover--neon .icard-cover-meta {
  letter-spacing: 1.5px;
}
.icard-cover--neon .icard-cover-meta::after {
  content: "";
  display: block;
  height: 3px;
  margin-top: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, ${t.accentColor}, transparent);
}
`;
    case "magazine":
    default:
      return `
.icard-cover--magazine .icard-cover-kicker {
  padding-bottom: 10px;
  border-bottom: 1px solid ${t.borderColor};
}
.icard-cover--magazine .icard-cover-title {
  font-size: 26px;
  margin-top: auto;
}
.icard-cover--magazine .icard-cover-excerpt {
  margin-top: 18px;
  margin-bottom: auto;
  border-left: 3px solid ${t.accentColor};
  padding-left: 12px;
}
.icard-cover--magazine .icard-cover-meta { margin-top: 0; }
.icard-cover--magazine .icard-cover-meta::after {
  content: "";
  display: block;
  width: 68px;
  height: 6px;
  margin: 14px auto 0;
  background-image: radial-gradient(circle, ${t.borderColor} 2.5px, transparent 3px);
  background-size: 14px 6px;
  background-repeat: repeat-x;
}
`;
  }
}

/**
 * 为 11 款情绪调色盘生成专属个性化自适应封面构图 CSS。
 * 数据移植自 card-mood-palettes.js 的 getMoodPaletteCoverCss。
 */
function buildMoodCoverCss(themeId: string, t: CardThemeTokens): string {
  switch (themeId) {
    case "warm":
      return `
.icard-cover--warm.icard-cover--adaptive { padding: 20px 20px 24px; }
.icard-cover--warm.icard-cover--adaptive .icard-cover-hero {
  width: calc(100% + 40px); height: 260px; min-height: 180px;
  margin: -20px -20px 14px; border-radius: 0 0 16px 16px; overflow: hidden;
  box-shadow: 0 8px 20px rgba(90, 74, 66, 0.12);
}
.icard-cover--warm.icard-cover--adaptive .icard-cover-hero-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.icard-cover--warm.icard-cover--adaptive .icard-cover-title {
  font-size: 25px; line-height: 1.35; margin-top: 4px;
}
.icard-cover--warm.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 40px; height: 3px; border-radius: 999px;
  background: ${t.accentColor}; margin: 10px 0 0;
}
`;
    case "cyber":
      return `
.icard-cover--cyber.icard-cover--adaptive .icard-cover-frame {
  order: -1; width: calc(100% + 40px); height: 240px; min-height: 170px;
  margin: -18px -20px 14px; border-radius: 0; overflow: hidden;
  border-bottom: 2px solid ${t.accentColor};
  box-shadow: 0 0 20px rgba(255, 0, 255, 0.25);
}
.icard-cover--cyber.icard-cover--adaptive .icard-cover-frame-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  filter: contrast(1.1) saturate(1.2);
}
.icard-cover--cyber.icard-cover--adaptive .icard-cover-title {
  font-weight: 800; letter-spacing: -0.5px;
}
.icard-cover--cyber.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 48px; height: 3px;
  background: ${t.accentColor}; margin: 8px 0 0;
  box-shadow: 0 0 10px ${t.accentColor};
}
`;
    case "ocean":
      return `
.icard-cover--ocean.icard-cover--adaptive .icard-cover-body {
  display: flex; flex-direction: column;
}
.icard-cover--ocean.icard-cover--adaptive .icard-cover-kicker { order: 1; margin-bottom: 6px; }
.icard-cover--ocean.icard-cover--adaptive .icard-cover-title {
  order: 2; font-size: 24px; line-height: 1.3; margin: 0 0 4px;
}
.icard-cover--ocean.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 36px; height: 3px; border-radius: 999px;
  background: ${t.accentColor}; margin: 8px 0 0;
}
.icard-cover--ocean.icard-cover--adaptive .icard-cover-frame {
  order: 3; width: calc(100% + 40px); height: 210px; min-height: 150px;
  margin: 12px -20px 10px; border-radius: 0; overflow: hidden;
}
.icard-cover--ocean.icard-cover--adaptive .icard-cover-frame-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0) 0%, #000 20%, #000 80%, rgba(0,0,0,0) 100%);
  mask-image: linear-gradient(to bottom, rgba(0,0,0,0) 0%, #000 20%, #000 80%, rgba(0,0,0,0) 100%);
}
.icard-cover--ocean.icard-cover--adaptive .icard-cover-excerpt { order: 4; }
.icard-cover--ocean.icard-cover--adaptive .icard-cover-meta { order: 8; margin-top: auto; }
`;
    case "forest":
      return `
.icard-cover--forest.icard-cover--adaptive .icard-cover-frame {
  order: -1; width: calc(100% + 40px); height: 275px; min-height: 190px;
  margin: -18px -20px 12px; border-radius: 0; overflow: hidden;
}
.icard-cover--forest.icard-cover--adaptive .icard-cover-frame-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 65%, rgba(0,0,0,0.4) 85%, rgba(0,0,0,0) 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 65%, rgba(0,0,0,0.4) 85%, rgba(0,0,0,0) 100%);
}
.icard-cover--forest.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 32px; height: 2.5px; border-radius: 999px;
  background: ${t.accentColor}; margin: 12px auto 0;
}
`;
    case "elegant":
      return `
.icard-cover--elegant.icard-cover--adaptive { padding: 22px; }
.icard-cover--elegant.icard-cover--adaptive .icard-cover-arch {
  width: calc(100% + 8px); height: 236px; min-height: 170px;
  margin: 6px -4px 14px; border: 1px solid ${t.borderColor}; border-radius: 4px;
  overflow: hidden; box-shadow: inset 0 0 16px rgba(0,0,0,0.4);
}
.icard-cover--elegant.icard-cover--adaptive .icard-cover-arch-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.icard-cover--elegant.icard-cover--adaptive .icard-cover-title {
  font-family: ${t.fontFamily}; font-size: 24px; letter-spacing: 0.5px;
}
.icard-cover--elegant.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 28px; height: 2px;
  background: ${t.accentColor}; margin: 12px auto 0;
}
`;
    case "sakura":
      return `
.icard-cover--sakura.icard-cover--adaptive .icard-cover-frame {
  order: -1; width: calc(100% - 12px); height: 240px; min-height: 170px;
  margin: 0 auto 16px; border-radius: 14px; overflow: hidden;
  box-shadow: 0 8px 24px rgba(255, 105, 180, 0.18), 0 0 0 1px rgba(255, 105, 180, 0.25);
}
.icard-cover--sakura.icard-cover--adaptive .icard-cover-frame-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.icard-cover--sakura.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 36px; height: 2.5px; border-radius: 999px;
  background: ${t.accentColor}; margin: 10px auto 0;
}
`;
    case "metal":
      return `
.icard-cover--metal.icard-cover--adaptive .icard-cover-hero {
  width: calc(100% + 40px); height: 250px; min-height: 180px;
  margin: -18px -20px 14px; border-radius: 0; overflow: hidden;
  border-bottom: 2px solid ${t.borderColor};
}
.icard-cover--metal.icard-cover--adaptive .icard-cover-hero-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.icard-cover--metal.icard-cover--adaptive .icard-cover-title {
  font-family: ${t.fontFamilyMono}; font-weight: 800; letter-spacing: -0.5px;
}
.icard-cover--metal.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 44px; height: 3px;
  background: ${t.accentColor}; margin: 8px 0 0;
}
`;
    case "starry":
      return `
.icard-cover--starry.icard-cover--has-image .icard-cover-bg {
  filter: saturate(1.2) brightness(0.85);
}
.icard-cover--starry .icard-cover-cyber-overlay {
  background: radial-gradient(circle at 50% 30%, rgba(155, 89, 182, 0.25) 0%, rgba(13, 15, 26, 0.75) 70%, rgba(13, 15, 26, 0.95) 100%);
}
.icard-cover--starry.icard-cover--adaptive .icard-cover-title {
  text-shadow: 0 0 16px rgba(155, 89, 182, 0.6);
}
`;
    case "minimal-white":
      return `
.icard-cover--minimal-white.icard-cover--adaptive { padding: 26px 24px; }
.icard-cover--minimal-white.icard-cover--adaptive .icard-cover-hero {
  width: 100%; height: 230px; min-height: 160px;
  margin: 0 0 18px; border-radius: 6px; overflow: hidden;
  border: 1px solid ${t.borderColor}; box-shadow: 0 4px 12px rgba(0,0,0,0.04);
}
.icard-cover--minimal-white.icard-cover--adaptive .icard-cover-hero-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.icard-cover--minimal-white.icard-cover--adaptive .icard-cover-title {
  font-weight: 600; letter-spacing: -0.2px;
}
.icard-cover--minimal-white.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 24px; height: 2px;
  background: ${t.accentColor}; margin: 10px 0 0;
}
`;
    case "yueling":
      return `
.icard-cover--yueling.icard-cover--adaptive { padding: 22px; }
.icard-cover--yueling.icard-cover--adaptive .icard-cover-arch {
  width: calc(100% - 16px); height: 250px; min-height: 180px;
  margin: 0 auto 16px; border-radius: 120px 120px 8px 8px; overflow: hidden;
  border: 1.5px solid ${t.accentColor}; box-shadow: 0 10px 25px rgba(0,0,0,0.45);
}
.icard-cover--yueling.icard-cover--adaptive .icard-cover-arch-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.icard-cover--yueling.icard-cover--adaptive .icard-cover-title {
  font-family: ${t.fontFamily}; font-size: 24px;
}
.icard-cover--yueling.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 32px; height: 2px;
  background: ${t.accentColor}; margin: 12px auto 0;
}
`;
    case "dark-night":
      return `
.icard-cover--dark-night.icard-cover--adaptive .icard-cover-frame {
  order: -1; width: calc(100% + 40px); height: 220px; min-height: 160px;
  margin: -18px -20px 14px; border-radius: 0; overflow: hidden;
  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
}
.icard-cover--dark-night.icard-cover--adaptive .icard-cover-frame-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  filter: contrast(1.05) brightness(0.9);
}
.icard-cover--dark-night.icard-cover--adaptive .icard-cover-title {
  letter-spacing: 1px;
}
.icard-cover--dark-night.icard-cover--adaptive .icard-cover-title::after {
  content: ""; display: block; width: 30px; height: 2px;
  background: ${t.accentColor}; margin: 12px auto 0;
}
`;
    default:
      return "";
  }
}

/**
 * 构建主题 scoped CSS。所有选择器以 .icard 开头；颜色/字体全部来自 token。
 * typography（B03）仅覆盖正文字号/行高与页面内边距；标题层级、页脚、表格字号保持固定。
 */
export function buildCardPageCss(theme: CardTheme, typography: CardTypography = {}): string {
  const t = theme.tokens;
  const fs = Number(typography.fontSize) > 0 ? Number(typography.fontSize) : null;
  const lh = Number(typography.lineHeight) > 0 ? Number(typography.lineHeight) : null;
  const pad = Number(typography.pagePadding) > 0 ? Number(typography.pagePadding) : null;
  const bodySize = fs !== null ? `${fs}px` : "14px";
  const bodyLine = lh !== null ? `${lh}` : "1.7";
  const liLine = lh !== null ? `${lh}` : "1.65";
  const quoteSize = fs !== null ? `${Math.max(10, fs - 0.5)}px` : "13.5px";
  const base = `
.icard {
  font-family: ${t.fontFamily};
  color: ${t.textColor};
}
.icard-page {
  position: relative;
  background: ${t.background};
  width: var(--icard-page-width, ${CARD_PAGE_WIDTH}px);
  min-height: var(--icard-page-height, ${CARD_PAGE_HEIGHT_3_4}px);
  box-sizing: border-box;
  padding: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.icard-content {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: ${t.contentGap}px;
  background: ${t.cardBackground};
  border-radius: 12px;
  box-shadow: ${t.cardShadow};
  box-sizing: border-box;
  padding: ${pad !== null ? `${pad}px` : `${t.pagePadding}px`};
}
.icard-content h1, .icard-content h2, .icard-content h3,
.icard-content h4, .icard-content h5, .icard-content h6 {
  color: ${t.textColor};
  font-family: ${t.headingFontFamily ?? t.fontFamily};
  font-weight: ${t.headingWeight};
  line-height: 1.35;
  margin: 0;
}
.icard-content h1 {
  font-size: 22px;
  padding-bottom: 6px;
  border-bottom: 3px solid ${t.accentColor};
}
.icard-content h2 {
  font-size: 19px;
  padding-left: 10px;
  border-left: 4px solid ${t.accentColor};
}
.icard-content h3 {
  font-size: 17px;
  padding-left: 9px;
  border-left: 3px solid ${t.accentColor};
}
.icard-content h4, .icard-content h5, .icard-content h6 { font-size: 15px; }
.icard-content p {
  margin: 0;
  font-size: ${bodySize};
  line-height: ${bodyLine};
  color: ${t.textColor};
  text-align: justify;
  letter-spacing: 0.02em;
}
.icard-content a {
  color: ${t.accentColor};
  text-decoration: none;
}
.icard-content strong {
  font-weight: 700;
  color: ${t.accentColor};
}
.icard-content em { font-style: italic; }
.icard-content del { text-decoration: line-through; }
.icard-content code {
  font-family: ${t.fontFamilyMono};
  font-size: 12.5px;
  background: ${t.codeBackground};
  border: 1px solid ${t.borderColor};
  border-radius: 4px;
  padding: 1px 5px;
}
.icard-content ul, .icard-content ol {
  margin: 0;
  padding-left: 20px;
  list-style: none;
}
.icard-content li {
  position: relative;
  font-size: ${bodySize};
  line-height: ${liLine};
  margin: 6px 0;
  padding-left: 18px;
}
.icard-content li .icard-marker {
  position: absolute;
  left: 0;
  text-align: right;
  min-width: 14px;
}
.icard-content ul ul, .icard-content ol ol, .icard-content ul ol, .icard-content ol ul {
  margin: 4px 0;
}
.icard-content li.icard-nested-1 { margin-left: 16px; }
.icard-content li.icard-nested-2 { margin-left: 32px; }
.icard-content li.icard-task .icard-task-box {
  display: inline-block;
  width: 14px;
  height: 14px;
  line-height: 14px;
  text-align: center;
  border: 1.5px solid ${t.borderColor};
  border-radius: 3px;
  margin-right: 6px;
  font-size: 11px;
  color: ${t.accentColor};
}
.icard-content li.icard-task.icard-task-done { color: ${t.textColorSecondary}; }
.icard-content blockquote {
  margin: 0;
  padding: 10px 14px;
  background: ${t.quoteBackground};
  border-left: 3px solid ${t.accentColor};
  border-radius: 0 6px 6px 0;
  font-size: ${quoteSize};
  line-height: ${liLine};
}
.icard-content blockquote .icard-callout-title {
  font-weight: 700;
  font-size: 13.5px;
  color: ${t.accentColor};
  margin-bottom: 4px;
}
.icard-content blockquote p { font-size: ${quoteSize}; }
.icard-content table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12.5px;
  line-height: 1.5;
}
.icard-content th, .icard-content td {
  border: 1px solid ${t.borderColor};
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
.icard-content th {
  background: ${t.codeBackground};
  font-weight: 700;
}
.icard-content img {
  max-width: 100%;
  border-radius: 12px;
  display: block;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
}
.icard-content img.icard-img-fit {
  max-height: var(--icard-content-height, 100%);
  width: auto;
}
.icard-content hr {
  border: none;
  border-top: 1px solid ${t.borderColor};
  margin: 4px 0;
  width: 100%;
}
.icard-footer {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 4px 2px;
  font-size: 11px;
  color: ${t.textColorSecondary};
}
.icard-footer .icard-page-num { font-variant-numeric: tabular-nums; flex-shrink: 0; }
.icard-footer .icard-watermark {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  letter-spacing: 2px;
  opacity: 0.75;
}
.icard-cover {
  padding: 26px;
}
.icard-cover--adaptive {
  height: var(--icard-page-height, ${CARD_PAGE_HEIGHT_3_4}px);
  min-height: 0;
}
.icard-cover--full-bleed {
  padding: 0;
  overflow: hidden;
}
.icard-cover-full-bleed-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.icard-cover--has-image {
  position: relative;
  overflow: hidden;
}
.icard-cover-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  z-index: 0;
}
.icard-cover-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.65) 100%);
  z-index: 1;
}
.icard-cover--has-image .icard-cover-body {
  position: relative;
  z-index: 2;
}
.icard-cover--has-image .icard-cover-title,
.icard-cover--has-image .icard-cover-excerpt,
.icard-cover--has-image .icard-cover-kicker,
.icard-cover--has-image .icard-cover-meta {
  color: #ffffff;
  text-shadow: 0 1px 3px rgba(0,0,0,0.5);
}
.icard-cover--adaptive.icard-cover--magazine { padding: 18px 20px 20px; }
.icard-cover--adaptive.icard-cover--magazine .icard-cover-body { flex-shrink: 0; }
.icard-cover--adaptive.icard-cover--magazine .icard-cover-hero {
  width: calc(100% + 40px); max-width: none; height: 296px; max-height: none; min-height: 204px;
  margin: -18px -20px 0; border-radius: 0; border: none; outline: none;
  overflow: hidden; flex: 0 1 auto; box-shadow: none;
}
.icard-cover--adaptive.icard-cover--magazine .icard-cover-hero-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 70%, rgba(0,0,0,0.5) 88%, rgba(0,0,0,0) 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 70%, rgba(0,0,0,0.5) 88%, rgba(0,0,0,0) 100%);
}
.icard-cover--adaptive.icard-cover--magazine .icard-cover-title { margin-top: 0; font-size: 23px; }
.icard-cover--adaptive.icard-cover--centered { padding: 18px 20px 20px; }
.icard-cover--adaptive.icard-cover--centered .icard-cover-frame {
  order: -1;
  width: calc(100% + 40px); max-width: none; height: 288px; min-height: 200px;
  margin: -18px -20px 0; border-radius: 0; border: none; outline: none; overflow: hidden;
  flex: 0 1 auto;
  box-shadow: none;
}
.icard-cover--adaptive.icard-cover--centered .icard-cover-frame-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 62%, rgba(0,0,0,0.55) 84%, rgba(0,0,0,0) 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 62%, rgba(0,0,0,0.55) 84%, rgba(0,0,0,0) 100%);
}
.icard-cover--adaptive.icard-cover--centered .icard-cover-title { margin-top: 0; font-size: 23px; }
.icard-cover--adaptive.icard-cover--luxury { padding: 18px 20px 20px; }
.icard-cover--adaptive.icard-cover--luxury .icard-cover-arch {
  width: calc(100% + 12px); max-width: none; height: 252px; min-height: 178px;
  margin: 8px -6px 16px; border-radius: 0; border: none; outline: none;
  flex: 0 1 auto;
  box-shadow: none;
}
.icard-cover--adaptive.icard-cover--luxury .icard-cover-arch-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.icard-cover--adaptive.icard-cover--luxury .icard-cover-title { margin-top: 0; font-size: 23px; }
.icard-cover--adaptive .icard-cover-kicker { margin-bottom: 8px; }
.icard-cover--adaptive .icard-cover-title::after { margin: 12px auto 0; }
.icard-cover--gradient-blue.icard-cover--adaptive .icard-cover-body {
  display: flex;
  flex-direction: column;
}
.icard-cover--gradient-blue.icard-cover--adaptive .icard-cover-kicker {
  order: 1;
  margin-bottom: 6px;
}
.icard-cover--gradient-blue.icard-cover--adaptive .icard-cover-title {
  order: 2;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
  margin-top: 0;
  margin-bottom: 0;
}
.icard-cover--gradient-blue.icard-cover--adaptive .icard-cover-frame {
  order: 3;
  width: calc(100% + 40px);
  max-width: none;
  height: 222px;
  min-height: 150px;
  margin: 12px -20px 8px;
  border-radius: 0;
  border: none;
  outline: none;
  flex: 0 1 auto;
  box-shadow: none;
}
.icard-cover--gradient-blue.icard-cover--adaptive .icard-cover-frame-img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  -webkit-mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0) 0%, #000 22%, #000 76%, rgba(0, 0, 0, 0) 100%);
  mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0) 0%, #000 22%, #000 76%, rgba(0, 0, 0, 0) 100%);
}
.icard-cover--gradient-blue.icard-cover--adaptive .icard-cover-excerpt {
  order: 4;
}
.icard-cover--gradient-blue.icard-cover--adaptive .icard-cover-meta {
  order: 8;
  margin-top: auto;
}
.icard-cover--gradient-blue.icard-cover--adaptive .icard-cover-title::after {
  content: "";
  display: block;
  width: 36px;
  height: 3px;
  border-radius: 999px;
  background: #2563eb;
  margin: 10px 0 0;
}
.icard-cover--forest-green.icard-cover--adaptive .icard-cover-frame {
  order: -1;
  width: calc(100% + 40px);
  max-width: none;
  height: 288px;
  min-height: 200px;
  margin: -18px -20px 0;
  border-radius: 0;
  border: none;
  outline: none;
  overflow: hidden;
  flex: 0 1 auto;
  box-shadow: none;
}
.icard-cover--forest-green.icard-cover--adaptive .icard-cover-frame-img {
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 62%, rgba(0, 0, 0, 0.55) 84%, rgba(0, 0, 0, 0) 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 62%, rgba(0, 0, 0, 0.55) 84%, rgba(0, 0, 0, 0) 100%);
}
.icard-cover--forest-green.icard-cover--adaptive .icard-cover-title {
  margin-top: 0;
  font-size: 23px;
}
.icard-cover--forest-green.icard-cover--adaptive .icard-cover-title::after {
  content: "";
  display: block;
  width: 36px;
  height: 2.5px;
  border-radius: 999px;
  background: #fcd34d;
  margin: 12px auto 0;
}
.icard-cover--dark-gold.icard-cover--adaptive .icard-cover-arch {
  width: calc(100% + 12px);
  max-width: none;
  height: 252px;
  min-height: 178px;
  margin: 8px -6px 16px;
  border-radius: 0;
  border: none;
  outline: none;
  position: relative;
  flex: 0 1 auto;
  box-shadow: none;
}
.icard-cover--dark-gold.icard-cover--adaptive .icard-cover-arch::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 0;
  background: linear-gradient(180deg, transparent 78%, rgba(24, 24, 27, 0.28) 100%);
  pointer-events: none;
}
.icard-cover--dark-gold.icard-cover--adaptive .icard-cover-title {
  margin-top: 0;
  font-size: 23px;
}
.icard-cover--dark-gold.icard-cover--adaptive .icard-cover-title::after {
  content: "";
  display: block;
  width: 32px;
  height: 2px;
  background: #f59e0b;
  margin: 12px auto 0;
}
.icard-cover--rose-gold.icard-cover--adaptive .icard-cover-arch {
  width: calc(100% + 12px);
  max-width: none;
  height: 252px;
  min-height: 178px;
  margin: 8px -6px 16px;
  border-radius: 0;
  border: none;
  outline: none;
  position: relative;
  flex: 0 1 auto;
  box-shadow: none;
}
.icard-cover--rose-gold.icard-cover--adaptive .icard-cover-arch::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 0;
  background: linear-gradient(180deg, transparent 78%, rgba(131, 24, 67, 0.14) 100%);
  pointer-events: none;
}
.icard-cover--rose-gold.icard-cover--adaptive .icard-cover-title {
  margin-top: 0;
  font-size: 23px;
}
.icard-cover--rose-gold.icard-cover--adaptive .icard-cover-title::after {
  content: "";
  display: block;
  width: 32px;
  height: 2px;
  background: #f472b6;
  margin: 12px auto 0;
}
.icard-cover-cyber-overlay {
  position: absolute; inset: 0; z-index: 1;
  background: none;
  background-image:
    linear-gradient(#ffffff0a 1px, transparent 1px),
    linear-gradient(90deg, #ffffff0a 1px, transparent 1px),
    linear-gradient(180deg, rgba(2, 6, 23, 0.42) 0%, rgba(2, 6, 23, 0.86) 62%, rgba(2, 6, 23, 0.94) 100%);
  background-size: 32px 32px, 32px 32px, 100% 100%;
}
.icard-cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  background: ${
    theme.id === "dark-gold" ? "#242427" :
    theme.id === "forest-green" ? "#042d22" :
    theme.id === "rose-gold" ? "#fff1f5" :
    theme.id === "gradient-blue" ? "#f0f7ff" :
    theme.id === "neon-purple" ? "#181533" : "#f3f4f6"
  };
  color: ${
    theme.id === "dark-gold" ? "rgba(245, 158, 11, 0.55)" :
    theme.id === "forest-green" ? "rgba(252, 211, 77, 0.5)" :
    theme.id === "rose-gold" ? "rgba(244, 114, 182, 0.55)" :
    theme.id === "gradient-blue" ? "rgba(37, 99, 235, 0.45)" :
    theme.id === "neon-purple" ? "rgba(232, 121, 249, 0.5)" : "#d1d5db"
  };
  border: none;
  border-radius: inherit;
  user-select: none;
}
.icard-cover-placeholder-icon {
  width: 56px;
  height: 56px;
  display: block;
}
.icard-cover-frame .icard-cover-placeholder-icon,
.icard-cover-arch .icard-cover-placeholder-icon {
  width: 52px;
  height: 52px;
}
.icard-cover-placeholder--full {
  width: 100%;
  height: 100%;
}
.icard-cover-bg--placeholder {
  background: ${
    theme.id === "dark-gold" || theme.id === "neon-purple" ? "#1f1f23" :
    theme.id === "forest-green" ? "#03241b" :
    theme.id === "rose-gold" ? "#fff1f5" : "#f3f4f6"
  };
}
.icard-cover-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.icard-cover-kicker {
  font-size: 11px;
  letter-spacing: 2.5px;
  font-weight: 600;
  color: ${t.accentColor};
}
.icard-cover-title {
  font-family: ${t.headingFontFamily ?? t.fontFamily};
  font-weight: ${t.headingWeight};
  color: ${t.textColor};
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.icard-cover--no-excerpt .icard-cover-title,
.icard-cover-body--no-excerpt .icard-cover-title,
.icard-cover-body:not(:has(.icard-cover-excerpt)) .icard-cover-title {
  margin-bottom: auto;
}
.icard-cover-excerpt {
  font-size: 13.5px;
  line-height: 1.7;
  color: ${t.textColorSecondary};
  overflow-wrap: anywhere;
}
.icard-cover-meta {
  font-size: 12px;
  color: ${t.textColorSecondary};
  overflow-wrap: anywhere;
}
${buildCoverCss(theme)}
`;
  return base + buildMoodCoverCss(theme.id, t);
}
