/**
 * AI 配图风格。
 *
 * 每种风格是一段拼在用户提示词后面的后缀。让用户只写「想画什么」，
 * 风格是产品给的确定性变量，避免每次生成的图风格漂移。
 */

export type AiImageStyle = {
  /** 风格 id，用于请求与选中态。 */
  id: string;
  /** 中文名。 */
  name: string;
  /** 一句话说明。 */
  desc: string;
  /** 拼在用户提示词后面的后缀；空串 = 不加后缀（自定义）。 */
  suffix: string;
};

/** 6 种预置风格 + 自定义。 */
export const STYLE_OPTIONS: AiImageStyle[] = [
  {
    id: "clay",
    name: "3D 粘土",
    desc: "软糯的 3D 粘土质感，马卡龙色",
    suffix: ", 3D clay style, soft pastel colors, cute, rounded shapes",
  },
  {
    id: "minimal",
    name: "极简矢量",
    desc: "扁平矢量插画，克制的配色",
    suffix: ", minimal vector illustration, flat design, limited color palette",
  },
  {
    id: "cyberpunk",
    name: "赛博朋克",
    desc: "霓虹灯光，暗色背景，未来感",
    suffix: ", cyberpunk style, neon lights, dark background, futuristic",
  },
  {
    id: "warm",
    name: "温暖治愈",
    desc: "手绘质感，柔和光线，治愈系",
    suffix: ", warm illustration, soft lighting, cozy atmosphere, hand-drawn style",
  },
  {
    id: "editorial",
    name: "编辑杂志",
    desc: "杂志排版感，高级优雅",
    suffix: ", editorial illustration, magazine style, sophisticated, elegant",
  },
  {
    id: "custom",
    name: "自定义",
    desc: "完全按你的描述来，不加任何风格",
    suffix: "",
  },
];

/** 按 id 取风格；不认识就按自定义处理（不加后缀）。 */
export function getStyle(styleId: string): AiImageStyle {
  return STYLE_OPTIONS.find(item => item.id === styleId) ?? STYLE_OPTIONS[STYLE_OPTIONS.length - 1]!;
}

/**
 * 组合风格提示词。
 *
 * @param styleId 风格 id（见 STYLE_OPTIONS）。
 * @param userPrompt 用户自己写的主题描述。
 */
export function getStylePrompt(styleId: string, userPrompt: string): string {
  const style = getStyle(styleId);
  const base = userPrompt.trim();
  if (!style.suffix) return base;
  return base ? `${base}${style.suffix}` : style.suffix.trim();
}
