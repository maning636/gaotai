/**
 * 封面模型。
 *
 * 从稿件属性派生封面字段：标题、主题色、比例、装饰元素。
 * 封面模型是纯数据，装配层负责把它渲染成封面 DOM。
 */

import type { CardTheme } from "../card-themes";
import { DEFAULT_RATIO, RATIO_PRESETS } from "./render-engine";

/** 封面装饰元素。 */
export type CoverDecoration =
  | { type: "rule"; width: number; color: string }
  | { type: "dotRow"; count: number; color: string }
  | { type: "glow"; color: string }
  | { type: "accentBar"; width: number; color: string }
  | { type: "gradientBar"; color: string };

/** 封面模型。 */
export type CoverModel = {
  /** 封面背景色。 */
  background: string;
  /** 内卡卡片背景。 */
  cardBackground: string;
  /** 主标题。 */
  title: string;
  /** 副标题（专题名或空）。 */
  subtitle: string;
  /** 强调色。 */
  accentColor: string;
  /** 文本主色。 */
  textColor: string;
  /** 次要文本色。 */
  textColorSecondary: string;
  /** 边框色。 */
  borderColor: string;
  /** 比例 key（3:4 / 3:5 / 9:16）。 */
  ratio: string;
  /** 封面页尺寸。 */
  size: { w: number; h: number };
  /** 封面风格变体。 */
  coverStyle: CardTheme["coverStyle"];
  /** 装饰元素列表。 */
  decorations: CoverDecoration[];
  /** 是否已有封面图（本地/远程 URL，空串表示无）。 */
  coverImage: string;
};

/** 生成封面模型。 */
export function buildCoverModel(
  project: { title: string; topicName?: string },
  theme: CardTheme,
  ratio: string = DEFAULT_RATIO,
  coverImage: string = "",
): CoverModel {
  const preset = RATIO_PRESETS[ratio] ?? RATIO_PRESETS[DEFAULT_RATIO];
  const t = theme.tokens;
  const decorations: CoverDecoration[] = [];

  switch (theme.coverStyle) {
    case "centered":
      decorations.push({ type: "accentBar", width: 56, color: t.accentColor });
      break;
    case "luxury":
      decorations.push({ type: "rule", width: 44, color: t.accentColor });
      break;
    case "neon":
      decorations.push({ type: "glow", color: t.accentColor });
      decorations.push({ type: "gradientBar", color: t.accentColor });
      break;
    case "magazine":
    default:
      decorations.push({ type: "dotRow", count: 5, color: t.borderColor });
      break;
  }

  return {
    background: t.background,
    cardBackground: t.cardBackground,
    title: project.title.trim() || "未命名稿件",
    subtitle: project.topicName ?? "",
    accentColor: t.accentColor,
    textColor: t.textColor,
    textColorSecondary: t.textColorSecondary,
    borderColor: t.borderColor,
    ratio,
    size: { w: preset.w, h: preset.h },
    coverStyle: theme.coverStyle,
    decorations,
    coverImage,
  };
}
