// 稿台多平台分发 · 共享工具
//
// 提供平台适配器共用的 DOM 工具与适配器全局注册表。
// 浏览器内容脚本没有 CommonJS require，因此采用 IIFE 把工具挂到
// globalThis.__GAOTAI_ADAPTERS__；Node 下（node --check / 单测）同时用
// module.exports 导出，两边共用同一套实现。

(function (global) {
  // 全局注册表（browser 路径：types.js 先注入，适配器随后注册进来）。
  const REGISTRY_NAME = "__GAOTAI_ADAPTERS__";
  const holder =
    (global && global[REGISTRY_NAME]) || (global && (global[REGISTRY_NAME] = { registry: {} }));

  // 找第一个匹配的选择器且可见的元素。
  function findEditable(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  // 把 HTML 写入 contenteditable，并触发 input 事件（富文本编辑器才认这个）。
  async function insertRich(editor, ctx) {
    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
      setTextarea(editor, ctx.content);
      dispatchInput(editor);
      return;
    }
    editor.focus();
    editor.innerHTML = ctx.html || `<p>${escapeHtml(ctx.content)}</p>`;
    dispatchInput(editor);
  }

  function setTextarea(el, value) {
    el.value = value;
  }

  function setInput(el, value) {
    el.value = value;
  }

  // 现代编辑器大多监听 input 事件；React 还要求原生 setter + 事件。
  function dispatchInput(el) {
    try {
      const proto =
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, el.value);
    } catch {
      /* 原生 setter 不可用时跳过 */
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const utils = {
    findEditable,
    insertRich,
    setTextarea,
    setInput,
    dispatchInput,
    escapeHtml,
  };

  // 暴露工具；registry 由适配器文件各自注册。
  holder.utils = utils;
  if (!holder.registry) holder.registry = {};

  if (typeof module !== "undefined" && module.exports) {
    module.exports = utils;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
