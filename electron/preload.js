// 预加载脚本：只暴露必要能力，避免把 node/fs 直接泄漏到渲染进程。
const { contextBridge, ipcRenderer } = require("electron");

let version = "unknown";
try {
  // preload 与本文件同在 electron/ 目录下；向上取项目根读 package.json 即可。
  version = require("../package.json").version;
} catch {
  /* 打包态路径变化时静默降级 */
}

contextBridge.exposeInMainWorld("gaotai", {
  platform: process.platform,
  version,
  /**
   * 取回本机登录口令。
   *
   * 桌面版的口令是首次运行时随机生成、随包自动登录的那一份，
   * 用户自己通常从来看不到它。如果会话 cookie 丢了（清了浏览器数据、
   * 换了机器、30 天过期），用户会被永久挡在登录页外面——没有任何找回入口。
   * 这个桥就是那条入口：主进程读本机 .env 后回传，渲染进程负责展示。
   *
   * 之所以放在主进程而不是做个 HTTP 接口：接口能被本机任意程序甚至
   * 恶意网页（靠 Sec-Fetch-Site 判断并不严密）调用，而主进程桥只能
   * 由本应用自己的窗口触发。
   */
  revealLocalPassword: () => ipcRenderer.invoke("gaotai:reveal-local-password"),
  /**
   * 浏览器扩展相关。
   *
   * 多平台分发依赖一个 Chrome/Edge 扩展，用户必须自己在扩展管理页里
   * 「加载已解压的扩展程序」并选中这个目录——浏览器不提供任何静默安装方式。
   * 所以要把真实目录告诉他，并能一键打开，省得他在安装目录里翻。
   */
  extensionDir: () => ipcRenderer.invoke("gaotai:extension-dir"),
  openExtensionDir: () => ipcRenderer.invoke("gaotai:open-extension-dir"),
});
