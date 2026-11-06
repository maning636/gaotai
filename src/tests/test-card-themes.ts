import { assertEqual, assertTrue, suite } from "./harness";
import {
  THEMES,
  getCardTheme,
  hasCardTheme,
  buildCardPageCss,
} from "../lib/card-themes";
import { CLASSIC_CARD_THEME_IDS } from "../lib/card-themes/classic-themes";
import { MOOD_PALETTE_THEME_IDS } from "../lib/card-themes/mood-palettes";

suite("卡片主题：数据完整性", ({ test }) => {
  test("6 套经典 + 11 套 mood = 17 套主题都能取到", () => {
    assertEqual(CLASSIC_CARD_THEME_IDS.length, 6);
    assertEqual(MOOD_PALETTE_THEME_IDS.length, 11);
    const all = [...CLASSIC_CARD_THEME_IDS, ...MOOD_PALETTE_THEME_IDS];
    assertEqual(Object.keys(THEMES).length, 17);
    for (const id of all) {
      assertTrue(hasCardTheme(id), `主题 ${id} 应存在`);
      const theme = getCardTheme(id);
      assertTrue(theme !== undefined, `主题 ${id} 应返回定义`);
      if (!theme) continue;
      assertEqual(theme.id, id);
      assertTrue(theme.name.length > 0, `主题 ${id} 应有中文名`);
      assertTrue(theme.tokens.fontFamily.length > 0);
      assertTrue(theme.tokens.background.length > 0);
      assertTrue(theme.tokens.textColor.length > 0);
      assertTrue(theme.tokens.accentColor.length > 0);
      assertTrue(theme.tokens.pagePadding > 0);
    }
  });

  test("getCardTheme 不存在的 id 返回 undefined", () => {
    assertEqual(hasCardTheme("no-such-theme"), false);
    assertEqual(getCardTheme("no-such-theme"), undefined);
  });

  test("每套主题 token 字段齐备", () => {
    for (const theme of Object.values(THEMES)) {
      const t = theme.tokens;
      for (const field of [
        "fontFamily",
        "fontFamilyMono",
        "background",
        "cardBackground",
        "cardShadow",
        "textColor",
        "textColorSecondary",
        "accentColor",
        "borderColor",
        "codeBackground",
        "quoteBackground",
        "headingWeight",
        "pagePadding",
        "contentGap",
      ] as const) {
        assertTrue(field in t, `主题 ${theme.id} 缺字段 ${field}`);
      }
      assertTrue(["magazine", "centered", "luxury", "neon"].includes(theme.coverStyle));
    }
  });
});

suite("卡片主题：CSS 生成", ({ test }) => {
  test("buildCardPageCss 返回非空 CSS，且以 .icard 为根", () => {
    for (const theme of Object.values(THEMES)) {
      const css = buildCardPageCss(theme);
      assertTrue(css.length > 100, `主题 ${theme.id} 生成的 CSS 过短`);
      assertTrue(css.includes(".icard"), `主题 ${theme.id} 的 CSS 缺少 .icard 根选择器`);
      assertTrue(css.includes(theme.tokens.accentColor), `主题 ${theme.id} 的 CSS 未填充强调色`);
    }
  });

  test("typography 覆盖字号/行高/边距", () => {
    const theme = getCardTheme("simple-white");
    assertTrue(theme !== undefined);
    if (!theme) return;
    const css = buildCardPageCss(theme, { fontSize: 17, lineHeight: 1.9, pagePadding: 32 });
    assertTrue(css.includes("font-size: 17px"), "应覆盖正文字号为 17px");
    assertTrue(css.includes("line-height: 1.9"), "应覆盖正文行高为 1.9");
    assertTrue(css.includes("padding: 32px"), "应覆盖页面内边距为 32px");
  });

  test("不同主题生成的 CSS 互不相同", () => {
    const a = getCardTheme("simple-white");
    const b = getCardTheme("dark-gold");
    assertTrue(a !== undefined && b !== undefined);
    if (!a || !b) return;
    assertTrue(buildCardPageCss(a) !== buildCardPageCss(b));
  });

  test("getCardTheme 返回的 CardTheme 结构类型正确", () => {
    const theme = getCardTheme("gradient-blue");
    assertTrue(theme !== undefined);
    if (!theme) return;
    assertEqual(theme.coverStyle, "centered");
    assertEqual(typeof theme.tokens.pagePadding, "number");
  });
});
