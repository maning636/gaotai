# 贡献指南

单人 + AI 协作的项目，流程从简，纪律从严。

## 开发环境

```powershell
npm install            # 依赖；无 Visual Studio 的机器加 --ignore-scripts，
                       # 然后手动跑 node scripts/ensure-runtime-deps.mjs
npm run dev            # 开发态 http://127.0.0.1:3060
npm run lint           # ESLint
npm test               # 373 条单测，不需要模型、不联网
npm run typecheck      # tsc --noEmit
npm run deps-gate      # 依赖声明闸门
npm run verify         # 以上四道全跑（提交前必跑）
npm run desktop:build  # 出包到 release/（先关掉运行中的 稿台.exe）
```

## 提交纪律

- 提交前本地必须全绿：`npm test` + `npm run typecheck`。
- `git status --short` 逐行过一眼，`.env` / `data/` / `release/` / `node_modules/` /
  `.tmp/` 不允许出现在列表里（.gitignore 已挡，仍需肉眼确认）。
- commit message 用中文、 conventional 前缀（feat / fix / docs / chore / release）。
- AI 主导的改动在 message 末行加 `AI-Model: <模型名>` trailer。
- 不 force push，不改写已推送的历史；出问题用新 commit 修。

## 改动红线

- 不给正文阶段（第四道工序）的模型加工具调用——实测会把思考额度吃光（见
  docs/file-map.md §6 坑清单）。
- 不往提示词里注入禁令清单——同上，真模型实测会 0 字产出。
- 改 `src/lib/layout-template.ts` 的清洗器前后必须跑 `npm test`，样式值里的
  `{{变量}}` 曾被整条丢弃且不报错。
- 涉及架构 / 工序模型 / 门禁规则的决策变更，先写 ADR
  （docs/architecture/decisions/）再动代码。

## 文档同步

改了行为就要同步改文档：接口与产品口径 → docs/spec.md；文件归属与坑 →
docs/file-map.md；版本变化 → CHANGELOG.md。
