# 架构决策记录（ADR）

本目录保存稿台仓库的架构决策记录（Architecture Decision Record）。ADR 用来说明
**为什么**做某个决定、否掉了哪些替代方案、代价是什么，以及实现落在哪里；它不是需求清单，
也不替代 [`docs/spec.md`](../../spec.md) 的产品与接口口径。

## 决策索引

| ADR | 决策 | 状态 | 日期 |
| --- | --- | --- | --- |
| [ADR-0001：四道工序流水线](0001-four-stage-pipeline.md) | 写作流程拆成四道工序，产出必须逐级签字 | 已采纳 | 2026-10-26 |
| [ADR-0002：正文阶段无工具](0002-prose-stage-no-tools.md) | 正文阶段不给模型工具、不注入禁令清单、不下字数指令 | 已采纳 | 2026-10-26 |
| [ADR-0003：私域分发](0003-distribution-private-channel.md) | 私域分发为主，Release 作归档；打包只做手动烟测 | 已采纳 | 2026-10-26 |
| [ADR-0004：模板库与 WeDraft 接入](0004-template-gallery.md) | 模板选择独立成页，WeDraft 按元素到部件转换纳入 | 已采纳 | 2026-10-26 |

## 维护约定

1. 涉及架构、工序模型或门禁规则的改动，先写 ADR，再动代码；提交纪律见
   [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)。
2. 新 ADR 使用四位递增编号与 `NNNN-short-title.md` 文件名，并在本索引登记。
3. 已采纳的 ADR 不直接改写历史；决定被推翻或替代时，新写 ADR 并在旧记录中链接替代关系。
4. ADR 至少包含背景、决策、否掉的方案、代价和实现位置；有实测证据时注明证据来源。
5. 架构现状的背景梳理见 [`docs/architecture-review.md`](../../architecture-review.md)，CI 硬门继续复用
   [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) 与
   [`.github/workflows/security.yml`](../../../.github/workflows/security.yml)，不另建并行流程。
