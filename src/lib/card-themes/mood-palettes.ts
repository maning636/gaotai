/**
 * 小红书 11 套爆款情绪调色盘（Note to RED 来源，MIT 开源协议适配；
 * 数据移植自 obsidian-wechat-converter services/card-mood-palettes.js）。
 *
 * 仅提供高质感底色与纯粹排版 Token，不含头像/UID 噪音挂件。
 * 这里只放数据与类型。
 */

import type { CardTheme } from "./classic-themes";

/** 11 套情绪调色盘 ID 列表。 */
export const MOOD_PALETTE_THEME_IDS = [
  "warm",
  "cyber",
  "ocean",
  "forest",
  "elegant",
  "sakura",
  "metal",
  "starry",
  "minimal-white",
  "yueling",
  "dark-night",
] as const;

/** 11 套调色盘完整 Token 与封面风格配置对象。 */
export const MOOD_PALETTE_THEMES: Record<string, CardTheme> = {
  warm: {
    id: "warm",
    name: "暖阳文艺",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#FFFAF5",
      cardBackground: "#FFF6E9",
      cardShadow:
        "0 4px 6px -1px rgba(90, 74, 66, 0.08), 0 2px 4px -1px rgba(90, 74, 66, 0.04)",
      textColor: "#5A4A42",
      textColorSecondary: "#8C7A70",
      accentColor: "#D2691E",
      borderColor: "#EADCCF",
      codeBackground: "#F5ECE1",
      quoteBackground: "#D2691E14",
      headingWeight: "700",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "magazine",
  },
  cyber: {
    id: "cyber",
    name: "赛博朋克",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#FFFFFF",
      cardBackground: "#F8F8F8",
      cardShadow: "0 0 15px rgba(255, 0, 255, 0.15)",
      textColor: "#333333",
      textColorSecondary: "#666666",
      accentColor: "#FF00FF",
      borderColor: "#E5E5E5",
      codeBackground: "#EEEEEE",
      quoteBackground: "#FF00FF14",
      headingWeight: "800",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "neon",
  },
  ocean: {
    id: "ocean",
    name: "深海之境",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#0A192F",
      cardBackground: "#112A45",
      cardShadow: "0 10px 20px -5px rgba(0, 0, 0, 0.5)",
      textColor: "#E6F7FF",
      textColorSecondary: "#8BB4D9",
      accentColor: "#40A9FF",
      borderColor: "#1E3D5F",
      codeBackground: "#0F243E",
      quoteBackground: "#40A9FF14",
      headingWeight: "700",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "centered",
  },
  forest: {
    id: "forest",
    name: "森林清晨",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#17231E",
      cardBackground: "#243830",
      cardShadow: "0 10px 20px -5px rgba(0, 0, 0, 0.4)",
      textColor: "#F1FFF6",
      textColorSecondary: "#A2C4B3",
      accentColor: "#68E6A0",
      borderColor: "#2E473D",
      codeBackground: "#1D2C26",
      quoteBackground: "#68E6A014",
      headingWeight: "700",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "centered",
  },
  elegant: {
    id: "elegant",
    name: "优雅暗色",
    tokens: {
      fontFamily: '"Songti SC", "Noto Serif SC", "SimSun", Georgia, serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#1A1721",
      cardBackground: "#2A2433",
      cardShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5)",
      textColor: "#C4B8DD",
      textColorSecondary: "#9A8DB0",
      accentColor: "#B490FF",
      borderColor: "#3D344B",
      codeBackground: "#241E2D",
      quoteBackground: "#B490FF14",
      headingWeight: "600",
      pagePadding: 28,
      contentGap: 16,
    },
    coverStyle: "luxury",
  },
  sakura: {
    id: "sakura",
    name: "樱花飞舞",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#1F1A1D",
      cardBackground: "#2D2428",
      cardShadow: "0 10px 20px -5px rgba(0, 0, 0, 0.4)",
      textColor: "#FFF5F7",
      textColorSecondary: "#C99BAA",
      accentColor: "#FF69B4",
      borderColor: "#44343B",
      codeBackground: "#292125",
      quoteBackground: "#FF69B414",
      headingWeight: "700",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "centered",
  },
  metal: {
    id: "metal",
    name: "金属科技",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#1E2228",
      cardBackground: "#282C34",
      cardShadow: "0 10px 20px -5px rgba(0, 0, 0, 0.4)",
      textColor: "#E0E0E0",
      textColorSecondary: "#9DA5B4",
      accentColor: "#4D8EE7",
      borderColor: "#3E4451",
      codeBackground: "#21252B",
      quoteBackground: "#4D8EE714",
      headingWeight: "700",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "magazine",
  },
  starry: {
    id: "starry",
    name: "星空梦境",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#0D0F1A",
      cardBackground: "#252640",
      cardShadow: "0 0 20px rgba(155, 89, 182, 0.25)",
      textColor: "#F0E6FF",
      textColorSecondary: "#A89AC5",
      accentColor: "#9B59B6",
      borderColor: "#3A3B59",
      codeBackground: "#1B1D30",
      quoteBackground: "#9B59B614",
      headingWeight: "700",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "neon",
  },
  "minimal-white": {
    id: "minimal-white",
    name: "极简纯白",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#FFFFFF",
      cardBackground: "#F5F5F5",
      cardShadow: "0 2px 4px rgba(0, 0, 0, 0.05)",
      textColor: "#444444",
      textColorSecondary: "#777777",
      accentColor: "#6C9EB8",
      borderColor: "#E5E5E5",
      codeBackground: "#EEEEEE",
      quoteBackground: "#6C9EB814",
      headingWeight: "700",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "magazine",
  },
  yueling: {
    id: "yueling",
    name: "悦灵雅棕",
    tokens: {
      fontFamily: '"Songti SC", "Noto Serif SC", "SimSun", Georgia, serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#1C1C1E",
      cardBackground: "#2C2C2E",
      cardShadow: "0 10px 20px -5px rgba(0, 0, 0, 0.5)",
      textColor: "#FFFFFF",
      textColorSecondary: "#B0B0B5",
      accentColor: "#C57512",
      borderColor: "#48484A",
      codeBackground: "#252528",
      quoteBackground: "#C5751214",
      headingWeight: "600",
      pagePadding: 28,
      contentGap: 16,
    },
    coverStyle: "luxury",
  },
  "dark-night": {
    id: "dark-night",
    name: "暗夜深空",
    tokens: {
      fontFamily:
        '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      fontFamilyMono:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace',
      background: "#1C1C1E",
      cardBackground: "#2C2C2E",
      cardShadow: "0 10px 20px -5px rgba(0, 0, 0, 0.5)",
      textColor: "#F2F2F7",
      textColorSecondary: "#98989D",
      accentColor: "#0A84FF",
      borderColor: "#38383A",
      codeBackground: "#252528",
      quoteBackground: "#0A84FF14",
      headingWeight: "700",
      pagePadding: 28,
      contentGap: 14,
    },
    coverStyle: "centered",
  },
};
