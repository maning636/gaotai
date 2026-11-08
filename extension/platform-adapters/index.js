// 稿台多平台分发 · 适配器注册表
//
// 汇总所有平台适配器。浏览器内容脚本由 manifest 按序注入：
// types.js → zhihu.js → juejin.js → csdn.js → xiaohongshu.js → feishu.js
// → weibo.js → toutiao.js → bilibili.js → baijiahao.js → segmentfault.js
// → oschina.js → cnblogs.js → index.js → content-script.js。
// 各适配器文件通过 IIFE 把自身注册到 globalThis.__GAOTAI_ADAPTERS__.registry；
// 本文件只负责读取和导出访问器。
//
// Node 下（node --check / 单测）各文件也各自 module.exports，可用 require 聚合。

(function (global) {
  const holder = (global && global.__GAOTAI_ADAPTERS__) || (global && (global.__GAOTAI_ADAPTERS__ = { registry: {}, utils: {} }));
  const registry = holder.registry || (holder.registry = {});

  // 兼容 Node require 路径（各适配器文件在 require 时已注册到全局）。
  const nodeRegistry = {};
  try {
    nodeRegistry.zhihu = require("./zhihu");
    nodeRegistry.juejin = require("./juejin");
    nodeRegistry.csdn = require("./csdn");
    nodeRegistry.xiaohongshu = require("./xiaohongshu");
    nodeRegistry.feishu = require("./feishu");
    nodeRegistry.weibo = require("./weibo");
    nodeRegistry.toutiao = require("./toutiao");
    nodeRegistry.bilibili = require("./bilibili");
    nodeRegistry.baijiahao = require("./baijiahao");
    nodeRegistry.segmentfault = require("./segmentfault");
    nodeRegistry.oschina = require("./oschina");
    nodeRegistry.cnblogs = require("./cnblogs");
    for (const id of Object.keys(nodeRegistry)) {
      if (!registry[id]) registry[id] = nodeRegistry[id];
    }
  } catch {
    /* 浏览器路径没有 require，忽略 */
  }

  const api = {
    registry,
    getAdapter: (id) => registry[id],
    list: () => Object.keys(registry),
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
