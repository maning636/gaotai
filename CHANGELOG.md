# 更新日志

本文件记录每个版本的用户可感知变化。格式约定：每条可溯源到 commit；
禁止编造未实施的功能。

## [0.1.2] - 2026-10-26

### Changed
- **模板管理页重做**：左侧模板改为小方块瓦片（不再一行一个大条），中间是选中模板的配置
  （颜色 / 部件 / 保存 / 删除），右侧手机预览随编辑实时更新；`/layout` 仍重定向到管理 Tab。
- 预览示例稿加入配图，能直接看出模板对图片的样式。

### Fixed
- 导入样式包的 `<img src="{{src}}">` 占位符在清洗时被丢弃，导致 28 套随包模板的图片
  全部为空；现明确放行 `{{src}}`，危险地址仍按白名单拦截。

## [0.1.1] - 2026-10-26

### Added
- **模板页 `/templates`（单页双 Tab）**：「模板库」平铺卡片挑模板 + 右侧手机预览，
  替代编辑器里的排版下拉框；「使用这套」把模板写回当前稿件。「模板管理」承载导入样式包、
  取舍部件、改色与保存（原 `/layout` 面板）；`/layout` 重定向到此页的管理 Tab。
  导航不再并列「排版」，只保留「模板库」。
- **WeDraft 随包模板 7 套**（MIT，Copyright (c) 2026 pafa and WeDraft contributors）：
  素笺 / 墨刊 / 青岚 / 蓝图 / 朱砂 / 小哈公社 / 小哈公社New。
  由 `scripts/convert-wedraft-templates.mts` 从上游「元素 → CSS」转换而来，
  许可与溯源见 `resources/layout-packs/LICENSE-wedraft` 与 `SOURCE-wedraft.json`。

### Security
- electron 40.10.6 → 45.0.0，清掉 dev 依赖审计中的 high（GHSA-jr5w-w6x2-84p9 等）。
  打包产物随之更新，已重跑打包态全链验收。

### Changed
- ESLint 启用 `eslint-plugin-react-hooks`：`rules-of-hooks` 与 `exhaustive-deps`
  纳入硬门；`set-state-in-effect` / `purity` 两条编译器优化建议规则暂关（有理由注释）。

## [0.1.0] - 2026-10-26

首个版本。四道工序写作工作台、本地优先。

### Added
- 四道工序流水线：材料解读 → 选题与方向 → 写作大纲 → 文章正文，
  每道工序产出需用户签字才进入下一道。
- 3 个写作技能包（gaotai-longform / gaotai-editorial / human-writing）、
  5 个公开专题、7 份阶段提示词（用户可改，改完重启生效）。
- 21 套随包排版样式包（20 套自 rico-md 翻译 + 1 套默认），支持导入、
  取舍、编辑、预览。
- 公众号闭环：素材导入（外链图自动下载转本地）、封面设置、预览、
  推草稿箱。
- 风格画像：手改与 AI 产出的差异被记录，塑造后续产出语气。
- 桌面客户端（Windows）：NSIS 安装包 + 免安装单文件版；
  数据全在 `%APPDATA%\gaotai`。
- 366 条单元测试，不需要模型、不联网。

### Known Issues
- 未签名分发：Windows SmartScreen 会提示「未知发布者」。
- 推公众号草稿需用户自行配置微信平台 IP 白名单。
