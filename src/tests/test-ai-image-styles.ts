import { assertEqual, assertTrue, suite } from "./harness";
import { STYLE_OPTIONS, getStyle, getStylePrompt } from "../lib/ai-image/styles";

/**
 * AI 配图风格测试。
 *
 * 只测纯函数逻辑：风格后缀的拼接、custom 不加后缀、选项完整性。
 * 不调任何模型接口。
 */

suite("AI 配图风格", ({ test }) => {
  test("STYLE_OPTIONS 有 6 项，且每项字段齐备", () => {
    assertEqual(STYLE_OPTIONS.length, 6);
    for (const style of STYLE_OPTIONS) {
      assertTrue(style.id.length > 0, `风格 ${style.id} 缺 id`);
      assertTrue(style.name.length > 0, `风格 ${style.id} 缺中文名`);
      assertTrue(style.desc.length > 0, `风格 ${style.id} 缺说明`);
      assertTrue(typeof style.suffix === "string", `风格 ${style.id} 缺 suffix`);
    }
  });

  test("5 种预置风格都带非空后缀", () => {
    const preset = STYLE_OPTIONS.filter(style => style.id !== "custom");
    assertEqual(preset.length, 5);
    for (const style of preset) {
      assertTrue(style.suffix.length > 0, `预置风格 ${style.id} 的后缀不该为空`);
    }
  });

  test("clay 风格在用户提示词后拼上 3D 粘土后缀", () => {
    const prompt = getStylePrompt("clay", "清晨的办公室");
    assertTrue(prompt.startsWith("清晨的办公室"), "用户提示词要在前面");
    assertTrue(prompt.includes("3D clay style"), "要拼上粘土风格");
    assertTrue(prompt.includes("soft pastel colors"), "要拼上柔和配色");
  });

  test("minimal 风格拼极简矢量后缀", () => {
    const prompt = getStylePrompt("minimal", "城市天际线");
    assertTrue(prompt.includes("minimal vector illustration"), "要拼上极简矢量");
    assertTrue(prompt.includes("flat design"), "要拼上扁平设计");
  });

  test("cyberpunk 风格拼赛博朋克后缀", () => {
    const prompt = getStylePrompt("cyberpunk", "夜之城");
    assertTrue(prompt.includes("cyberpunk style"), "要拼上赛博朋克");
    assertTrue(prompt.includes("neon lights"), "要拼上霓虹");
  });

  test("warm 风格拼温暖治愈后缀", () => {
    const prompt = getStylePrompt("warm", "午后阳台的猫");
    assertTrue(prompt.includes("warm illustration"), "要拼上温暖插画");
    assertTrue(prompt.includes("hand-drawn style"), "要拼上手绘");
  });

  test("editorial 风格拼编辑杂志后缀", () => {
    const prompt = getStylePrompt("editorial", "时尚人像");
    assertTrue(prompt.includes("editorial illustration"), "要拼上编辑插画");
    assertTrue(prompt.includes("magazine style"), "要拼上杂志风");
  });

  test("custom 风格不加任何后缀", () => {
    assertEqual(getStylePrompt("custom", "一只戴眼镜的猫"), "一只戴眼镜的猫");
  });

  test("不认识的风格 id 按 custom 处理（不加后缀）", () => {
    assertEqual(getStylePrompt("no-such-style", "纯描述"), "纯描述");
  });

  test("用户提示词为空时，预置风格返回后缀本体", () => {
    const prompt = getStylePrompt("clay", "   ");
    assertTrue(prompt.includes("3D clay style"), "空提示词也要返回风格提示");
  });

  test("getStyle 按 id 取到对应风格", () => {
    assertEqual(getStyle("clay").name, "3D 粘土");
    assertEqual(getStyle("custom").name, "自定义");
  });
});
