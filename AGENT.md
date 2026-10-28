# AGENT.md —— AI 与人共用的仓库纪律入口

> 本文件是仓库卫生与推送规则的**唯一权威**。做任何 git 操作前先读完本文件。
> 操作协议（阶段状态机）见 engineering-standard 的 AGENT-PROTOCOL；本文件只管本仓库的红线。

## Repo Hygiene（仓库卫生）

1. 本仓库只装：源码、文档、构建脚本、随包资源（提示词 / 技能包 / 专题 / 样式包）。
2. 运行时数据绝不入库（见下面 Local-Only Data 清单）。
3. 提交前 `git status --short` 逐行过目；出现清单里的任何路径立即停止并排查。
4. 误入库的运行时文件：`git rm --cached <path>` + 补 `.gitignore`；禁止用
   `git reset --hard` / `git clean` 掩盖。

## Push Rules（推送规则）

1. **禁 `git add -A` / `git add .`** —— 显式列路径提交。
2. **禁 force push**；已推送的历史不改写，出问题用新 commit 修。
3. **禁 `git commit --no-verify`**、禁注释/跳过 CI 硬门。
4. push 前本地全绿：`npm run verify`（lint + typecheck + test + deps-gate，
   与 CI 的四道硬门一一对应）。
5. 远程只有 `origin` = `https://github.com/maning636/gaotai.git`（HTTPS，
   凭据走 Windows 凭据管理器；本机 SSH key 未注册 GitHub，勿走 SSH）。
6. push 挂死先探网络（直连 / 代理 `127.0.0.1:7897`），别原地重试。
7. AI 主导的 commit 末行必带 `AI-Model: <模型名>` trailer。

## Local-Only Data（本机数据，绝不入库）

| 路径 | 内容 |
| --- | --- |
| `.env` | 真密钥（模型 Key、登录口令、会话密钥）；只有 `.env.example` 可入库 |
| `data/` | 本地 SQLite（稿件、风格画像、登录日志）+ 加密模型配置 |
| `images/` | 本地配图素材 |
| `.tmp/` | 调试脚本与验证产物 |
| `node_modules/` `\.next\` `dist/` `release/` | 依赖与构建产物，打包时重新生成 |
| `*.tsbuildinfo` | TS 增量缓存 |
| `%APPDATA%\gaotai\`（用户机器） | 桌面版运行时数据，与仓库无关 |

## Interface Border（接口边界）

- `src/lib/` 是领域层：页面（`src/app/`）只通过 API 路由调它，不反向 import。
- `electron/main.js` 只负责窗口、起后端、启动令牌；业务逻辑不进 electron 层。
- 改 `src/lib/layout-template.ts` 清洗器前后必须跑 `npm test`（历史坑：样式值
  里的 `{{变量}}` 被整条丢弃且不报错）。

## 授权体系

- **目录**：`license-server/`（授权服务器，零依赖）、`src/lib/license/`（客户端授权核心：
  机器码 / 令牌 / 门禁 / 资产同步）、`src/app/license/`（授权页）、`docs/license-protocol.md`（唯一契约）。
- **起本地授权服务器**：`cd license-server && node scripts/keygen.mjs && node scripts/bundle-assets.mjs && node server.mjs`（默认 `127.0.0.1:8787`）。
- **发测试码**：`node license-server/scripts/license-cli.mjs issue --contact <微信号/手机号>`；
  客户端激活页输入 `GT-XXXX-XXXX-XXXX-XXXX`。测试用 `npm test`（license-server 下 `node --test`）。
- **`GAOTAI_LICENSE_BYPASS=1`**：门禁放行，仅供本地开发 / 测试。**红线：绝不进打包产物**
  （打包脚本会剔除该变量）；提交前确认产物里没有它。
- **改协议先改文档**：客户端与授权服务器分头实现，改字段必须先改 `docs/license-protocol.md`，
  再同步 `license-server/` 与 `src/lib/license/`。
