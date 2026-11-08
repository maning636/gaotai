// X（Twitter）适配器：x.com/compose/post 发推编辑器，正文是 contenteditable 区域。
// X 没有标题字段，只有正文，且正文长度受限（280 字符，中文按 140 字计）。
// 每个适配器导出 { id, name, syncMode, fill }，并由 index.js 统一注册。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const { findEditable, insertRich } = holder.utils || {};

  const LIMIT = 280; // X 正文长度限制：中文按 2 权重计（即中文 140 字）。

  // 统计加权长度：CJK 及全角字符计 2，其余计 1。
  function weightedLength(text) {
    let total = 0;
    for (const ch of text) {
      total += /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
    }
    return total;
  }

  // 按权重截断到 LIMIT，返回截断后的文本与是否被截断。
  function truncate(text) {
    let total = 0;
    let end = 0;
    for (let i = 0; i < text.length; i++) {
      const w = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(text[i]) ? 2 : 1;
      if (total + w > LIMIT) break;
      total += w;
      end = i + 1;
    }
    return { text: text.slice(0, end), truncated: end < text.length };
  }

  const adapter = {
    id: "x",
    name: "X",
    syncMode: "dom",
    fill: async (ctx) => {
      const editor = findEditable([
        'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
        'div[contenteditable="true"][data-testid="tweetTextarea_1"]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
      ]);
      if (!editor) return { ok: false, reason: "未找到 X 发推编辑器（先进入发推页面）" };

      const content = ctx.content || "";
      if (weightedLength(content) > LIMIT) {
        const { text, truncated } = truncate(content);
        ctx = Object.assign({}, ctx, { content: text, html: null });
        if (truncated) {
          await insertRich(editor, ctx);
          return { ok: true, warning: "正文超过 280 字符限制，已自动截断" };
        }
      }
      await insertRich(editor, ctx);
      return { ok: true };
    },
  };

  holder.registry[adapter.id] = adapter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapter;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
