# ADR-0003：私域分发，不出 GitHub Release；打包只做手动烟测

日期：2026-10-26 ｜ 状态：已采纳 ｜ 决策者：maning636
证据档：分发链路已实测（本机出包 + 干净 Windows runner 烟测）

## 背景

稿台是单机桌面工具，没有服务器、没有账号体系，用户从「公众号文章 → 加微信 → 收 exe」
这条私域路径拿到软件（见 [`部署与交接方案.md`](../../部署与交接方案.md) §5）。
仓库本身是 **Private**，产物约 106 MB、未签名，面向的是具体的人而不是公开下载站。

标准模板里的 `release.yml` 默认假设「tag → 构建 → 上传 GitHub Release 附件」，
并带两条守卫：**体积守卫**（防止安装包异常膨胀）与**防覆盖**（防止同一版本号被重复上传、
静默替换）。这两条守卫是为「公开、自动、可被外部下载」的发布渠道设计的；
在本项目的分发模型下，它们守的不是同一件事。

同时，`electron-builder.yml` 里的 `appId: com.maning.gaotai` 带着个人标识。
去掉它会影响安装目录与覆盖安装/升级路径，不能随手改。

## 决策

1. **私域分发，不发 GitHub Release。** 仓库保持 Private；不建 tag 触发的发布流水线，
   也不切公开 Releases。产物只经人工（微信）交付。
2. **正式产物只在本地出。** `npm run desktop:build` 是唯一发布路径：
   `next build → ensure-runtime-deps → copy-standalone-assets → sanitize-standalone →
   prepare-resources → electron-builder --win`，产物落在 `release/`
   （`Gaotai-Setup-<version>.exe` 与免安装版）。
3. **CI 只做手动打包烟测（软门）。** `.github/workflows/e2e-packaged.yml` 仅
   `workflow_dispatch` 触发，整 job `continue-on-error`，只回答「一台干净的 Windows
   能不能从源码出包」，产物作为 artifact 保留 7 天供人工下载试用；
   不打 tag、不写 Release、不参与合并门禁。硬门仍然只有类型检查、单测、密钥扫描与依赖审计。
4. **体积守卫与防覆盖由本地纪律 + CHANGELOG 承担（决策豁免）。**
   标准 `release.yml` 的这两条守卫在本项目**明确豁免**，替代手段：
   - 出包后核对 `release/` 产物清单（安装包 / 免安装版 / source zip）与体积，异常先查再发；
   - 版本号只由 `package.json` 决定，改版本必须同时写 `CHANGELOG.md`；
   - 同一个版本号不重复发给不同人——需要改动就升版本号重出，不覆盖旧包。
5. **`appId` 中性化推迟到转公开仓时执行（trigger-based）。**
   触发条件：仓库可见性改为 public，或首次对外公开发布。届时先改 `appId`
   （换成不含个人标识的值）再出包，并同步升级/覆盖安装说明。

## 否掉了什么

- **GitHub Releases 自动发布**：公开可下载与私域漏斗不匹配；版本节奏外泄；
  未签名包公开挂出去会放大 SmartScreen 警告与举报面。
- **tag 触发的 release.yml**：没有发布目标，流水线只会空跑；体积守卫防的是
  Release 附件被替换，本地没有这个攻击面。
- **把打包做成 push 触发的硬门**：每次 push 产出 100 MB+、耗时十几到二十几分钟，
  失败还多半是上游下载源抖动——用基础设施抖动拦代码合并，是错的信号。
- **现在就把 `appId` 改成中性值**：会切断已分发包的覆盖安装/升级路径；
  私域阶段匿名化没有实际收益。

## 代价

- **CI 产物不代表可交付**。烟测绿了只证明「能出包」；装得上、能启动、四道工序跑得通
  仍靠真机脚本与人工验收（`.tmp/` 下的打包态验证脚本，属临时脚本、不入库）。
- **没有自动的体积/覆盖守卫**。靠人守纪律，一次疏忽就可能把旧包发出去或漏发新包。
  缓解：版本号唯一 + CHANGELOG 记录 + 出包后核对清单。
- **私域分发不可审计**。没有下载记录，用户报问题时只能靠安装包名与界面版本号回溯。
- **`appId` 留下一次性技术债**。转公开时是一次需要同步升级策略的改动，不能只改配置。

## 实现

- 打包配置：`electron-builder.yml`（`appId` / `productName` / `nsis` + `portable`）。
- 出包链：`package.json` 的 `desktop:build`。
- 软门烟测：`.github/workflows/e2e-packaged.yml`。
- 版本与体积纪律：`CHANGELOG.md`。
- 分发路径与用户侧承诺：`docs/部署与交接方案.md` §5。

## 修订记录（2026-10-26 晚，用户拍板）

**变更：同时维护 GitHub Release 作为归档/下载通道。**

用户明确要求仓库的 Releases 区不能是空的。调整后的口径：

1. **私域分发仍是主渠道**（公众号 → 微信 → 发 exe），不变。
2. **每个版本在 GitHub Releases 建一条 release**，附安装包、免安装版与源码归档，
   作为版本归档与内部分发地址（仓库 Private，只有所有者可下载）。
3. **仍不建 tag 触发的自动发布流水线**（CI 不打包上传）；release 由人工确认后创建，
   产物是本机 `desktop:build` 的结果。
4. 版本号单一真源仍是 `package.json`；tag 与 release 名用 `v<version>`，附件名与版本一致。
5. 体积与防覆盖纪律：出包后人工核对 `release/` 清单；同一版本号已发布时不再覆盖资产，
   需要修正就发新版本号。

## 复查触发条件

出现以下任一情况时重开本 ADR：

- 仓库转 public，或开始对外公开发布；
- 需要自动更新（autoUpdater）或增量更新；
- 分发量增长到人工发 exe 不可维护，需要下载页/对象存储。
