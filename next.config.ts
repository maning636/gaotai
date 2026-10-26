import type { NextConfig } from "next";
import path from "node:path";

// 稿台的构建配置。
//
// output: "standalone" —— 桌面客户端以 `node server.js` 拉起后端，
// 不依赖源码树，用户机器上不需要装 Node 依赖。
//
// serverExternalPackages —— 原生模块必须由 Node 端按绝对路径 require，
// 打进 bundle 后运行时找不到 .node 二进制。SQLite 与 canvas 都是 N-API（ABI 无关），
// 因此不需要针对 Electron 重新编译。
//
// outputFileTracingExcludes —— 兜底剔除密钥与个人数据。
// resources/ 不进 standalone：桌面版由 electron-builder 的 extraResources 单独分发到
// resources/app-resources，再通过 GAOTAI_RESOURCE_DIR 指向它。
// Turbopack 的追踪规则对动态文件访问不总是听话，真正的最后一道闸门在打包脚本层
// （scripts/sanitize-standalone.mjs）。
const config: NextConfig = {
  output: "standalone",
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["better-sqlite3", "canvas"],
  outputFileTracingExcludes: {
    "/**": [
      "./.env",
      "./.env.*",
      "./data/**/*",
      "./.tmp/**/*",
      "./release/**/*",
      "./dist/**/*",
      "./electron/**/*",
      "./scripts/**/*",
      "./resources/**/*",
      "./node_modules/.cache/**/*",
      "./package-lock.json",
      "./**/package-lock.json",
      "./**/tsconfig.tsbuildinfo",
    ],
  },
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default config;
