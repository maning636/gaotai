# 项目进展与仓库记忆

> 更新日期：2026-11-26。这里记录接续者必须知道的仓库事实，不重复产品手册或部署交接细节。

## 当前快照

| 项目 | 事实 |
| --- | --- |
| 当前产品版本口径 | **0.8.1**，来源为本地 `main` 的 `package.json` |
| 本地 `main` | `1b79cbd19a472b2323aac7424482a13087691339` |
| fetch 后的 `origin/main` | `543d06b0506b66ee4ced48b5bd549649d901f218` |
| 治理分支 | `chore/repo-governance`，从上述 `origin/main` 创建 |
| PR 基线版本 | `origin/main` 的 `package.json` 仍为 **0.7.0**；本治理 PR 不改版本 |
| 本地领先 | `main` 比 `origin/main` 多 **5 个提交**，且不落后 |
| tag 漂移 | 最新 tag 为 `v0.2.0`（`88b610ab4a3cec7af266d6e238b722e504f4a8e0`），与产品版本 0.8.1 不一致；当前 tag 清单没有 0.6.3、0.7.0、0.8.0 或 0.8.1 对应 tag |

### 未纳入治理 PR 的 5 个本地提交

以下提交只存在于本地 `main`，按时间顺序为：

| 提交 | 主题 |
| --- | --- |
| `848c1fc` | `feat: 稿台 MCP Server——豆包/WorkBuddy 可直接驱动稿台写稿推草稿` |
| `a2ff9e3` | `chore: 版本升到 0.8.0（MCP 接入版）` |
| `639ea33` | `fix: mcp-server.mts 加入随包分发` |
| `8cfa905` | `feat: AI 接入页改最短路径 + MCP 源码闭包随包` |
| `1b79cbd` | `docs: 产品全功能介绍（面向分发平台评估）` |

治理 PR 只从 `origin/main` 增加 PR 模板、Issue 表单、ADR 索引和本记忆文件。上述 5 个提交必须留在
本 PR 之外，后续如需合入应单独审查和提交，不得借治理 PR 夹带。

## 现有工程结构

- 仓库纪律唯一权威：[`AGENT.md`](../../AGENT.md)；贡献流程：[`CONTRIBUTING.md`](../../CONTRIBUTING.md)。
- 架构决策：[`docs/architecture/decisions/README.md`](../architecture/decisions/README.md)。
- 产品与接口口径：[`docs/spec.md`](../spec.md)；文件归属与坑：[`docs/file-map.md`](../file-map.md)。
- CI 继续使用现有四道硬门与安全扫描，不为治理文件新建并行流程：
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)、
  [`.github/workflows/security.yml`](../../.github/workflows/security.yml)。

## 后续接续

1. 治理 PR 合并后再单独处理本地领先的 5 个提交，先确认它们与最新 `origin/main` 的关系。
2. 版本与 tag 漂移只在此记录，不在本 PR 改 `package.json`、`CHANGELOG.md` 或创建 tag。
3. 后续里程碑、分支基线变化或验证结论变化时，更新本页并保留可核对的 SHA 与命令结果。
