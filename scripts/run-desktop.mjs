// 启动 Electron 壳的通用入口：通过参数注入 GAOTAI_MODE，规避 Windows/Linux 环境变量语法差异。
// npm 里可以直接写成 "desktop:dev": "node scripts/run-desktop.mjs dev"，不用引 cross-env。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const mode = process.argv[2] || "production";
if (mode !== "dev" && mode !== "production") {
  console.error(`[run-desktop] 未知模式: ${mode}（仅支持 dev / production）`);
  process.exit(1);
}

const require_ = createRequire(import.meta.url);
const electronBin = require_("electron");

const child = spawn(electronBin, ["."], {
  stdio: "inherit",
  env: { ...process.env, GAOTAI_MODE: mode },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
