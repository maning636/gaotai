# ADR-0004：模板选择改为独立「模板库」页 + 手机预览；WeDraft 以元素→CSS 到部件→HTML 的转换方式纳入

日期：2026-10-26 ｜ 状态：已采纳 ｜ 决策者：maning636
设计规则：`docs/design/template-gallery.md`（本 ADR 的事实来源）

## 背景

- **下拉框看不到效果**：正文页的排版选择器是 `<select>`（`src/app/projects/[id]/editor.tsx` 约 1025 行），用户只能看见模板名字，
  看不到实际排版效果。挑一套要「先选了再看手机里像不像」，来回几轮才算定下。
- **`/layout` 是管理页，不适合做浏览**：现有的 `/layout` 承担「导入样式包 → 取舍部件 → 编辑色值 → 存为模板」，
  一屏塞下导入、编辑、预览三件事。它是给「已经决定要调模板」的用户用的，不适合「快速挑一套」。
- **WeDraft 有 7 套质量合格的模板可用**：[pafa/WeDraft](https://github.com/pafa/WeDraft)（MIT，
  Copyright (c) 2026 pafa and WeDraft contributors）里的 `reading-editions.ts` 5 套（素笺 / 墨刊 / 青岚 /
  蓝图 / 朱砂）+ `default-business.json`（小哈公社）+ `next-edition.json`（小哈公社 New）都做得很好，
  但模型是「**元素 → CSS 声明**」（`article` / `heading2` / `paragraph` …），与稿台的「**部件 → HTML 模板**」
  （`root` / `heading` / `paragraph` … + `{{content}}` 占位符）不是一回事。

## 决策

1. **模板选择抽成独立页面 `/templates`（模板库）**：两栏布局——
   - 左/主区平铺卡片网格（`repeat(auto-fill, minmax(220px, 1fr))`）：每张卡含模板名、来源徽标
     （内置 / 随包 / 我的 / WeDraft）、一句描述、按该模板渲染的等比缩小预览、当前使用标记；
     点击**只更新右侧手机预览，不立即应用**。
   - 右/预览栏 sticky 手机：iPhone 外形（屏幕 440×956、外框 456×972），带顶部状态栏与微信顶栏，
     屏幕内渲染同一份示例稿，可滚动；底部「使用这套」带 `?project=<id>` 时应用到该稿件并跳回编辑器。
   - 窄屏（<1024px）手机预览折叠到卡片列表下方或弹层，不遮挡卡片。
2. **同一页面用 Tab 承载管理**：`/templates` 顶部两个 Tab——「模板库」浏览、「模板管理」导入/取舍/编辑/删除。
   `/layout` 重定向到 `/templates?tab=manage`。同一份模板库只该有一个入口；浏览和管理是两种操作模式，
   不是两个产品。
3. **编辑器侧接入**：正文页移除 `<select>`，改为一行「排版：当前模板名」+「换排版」按钮；
   按钮跳 `/templates?project=<id>&from=editor`，用户「使用这套」后回到 `/projects/<id>` 让编辑器按既有
   逻辑重新读取该稿件的模板。
4. **WeDraft 以「元素→CSS 到 部件→HTML」的转换方式纳入，不引入其渲染器**：
   生成 `resources/layout-packs/wedraft-<id>.json`，id 命名 `builtin:wedraft-<原 id>`，name 用
   「WeDraft · <中文名>」，description 保留原文并加一行「源自 WeDraft（MIT）」；
   CSS 对象按 `property: value` 拼成内联样式，只走 `src/lib/layout-template.ts` 的清洗器白名单，
   生成物必须能被 `parseLayoutPack()` 解析且 0 warnings。
   转换脚本 `scripts/convert-wedraft-templates.mts`（tsx 执行）入库，参考仓库路径由参数给（默认
   `.tmp/refs/WeDraft`），可重复运行；**不依赖 `.tmp/` 下的临时文件参与构建**。
5. **MIT 义务**：根 `NOTICE.txt` 增加 WeDraft 条目；`resources/layout-packs/LICENSE-wedraft` 放 MIT 原文；
   `resources/layout-packs/SOURCE-wedraft.json` 记录 repo / commit / license / 转换说明；
   模板卡片显示「WeDraft · 素笺」这类来源前缀。

## 否掉了什么

- **编辑器内嵌弹窗 / 大图预览**：弹窗要占正文页的编辑面，遮罩一开就打断写作；用户只是想看一眼排版，
  弹窗打开/关闭的往返成本远高于跳一个独立页。
- **直接依赖 WeDraft 的渲染器**：WeDraft 有自己的模板引擎与 HTML 结构，与稿台部件模型
  （`{{content}}` 占位符、保留名、清洗器白名单）是两套语义。引入双渲染器会让「改一处色值」
  要同步维护两套渲染、两套预览，两边漂移不可控；而且 WeDraft 的组件体系
  （如 `headingNumber` / `quoteMark` 装饰、reference 编号）在稿台的部件目录里没有对应位置。
- **把模板库塞进管理表单里**：管理页的输入密集（表单 + 部件勾选 + 色值编辑器），
  如果和浏览混在同一屏滚动，用户在挑排版时会被「删模板」「存为我的」挤走视线。
  最终方案是**同一页面、两个 Tab**——共用一份模板清单与入口，但浏览与管理各自独占一屏，
  不互相污染。这样既回答了「为什么不是两个页面」，也保住了「快速挑一套」的轻路径。

## 代价

- **转换丢失装饰能力（已知限制）**：WeDraft 的 `headingNumber`（章节序号）、`quoteMark`（引用装饰符）、
  `imageCaption`（独立图注部件）、`referenceTitle` / `referenceNumber`（参考文献样式）在稿台的部件模型里没有
  对应位置。第一版转换：
  - `quote` 保留竖线/底色/内边距，`quoteMark` 装饰字符丢弃；
  - `image` 图注若源模板写死为独立块则并入 `image` 部件（`{{caption}}` 若模型支持则用，否则不输出）；
  - `headingNumber` / `headingText` / `reference*` 一律丢弃并在转换脚本的 warnings 里点名。
  这些限制在 `docs/design/template-gallery.md` §3.2 的映射表里逐条记着。
- **新增页面维护成本**：`src/app/templates/` 下多一组文件（`page.tsx` / `gallery.tsx` /
  `phone-preview.tsx` / `templates.module.css`），加上导航项与编辑器接入点。
- **手机框为固定比例模拟，不是真实微信环境**：手机预览只是「屏幕 440×956 + 微信顶栏」的 CSS 模拟，
  字体渲染、行高压缩、Emoji 显示、iOS 版微信 vs 安卓版微信的差异化，一概不模拟。
  真机验证要走「复制排版正文」或推草稿——预览只回答「结构和色值是不是我想要的」，不回答「微信里长得对不对」。
- **卡片预览是缩小后的示例稿**：与手机预览共享同一份示例稿渲染结果，缩到卡大小时可读性有限；
  想看清细部必须点开手机预览。

## 实现

- 转换脚本：`scripts/convert-wedraft-templates.mts`（tsx 执行，产物可重复生成）。
- 随包生成物：`resources/layout-packs/wedraft-*.json`（7 套）+
  `LICENSE-wedraft` + `SOURCE-wedraft.json`。
- 转换测试：`src/tests/wedraft-convert.test.ts`（7 套全部转换成功、accent 一致、关键部件齐、
  `parseLayoutPack()` 0 warnings、2 套关键色值断言）。
- 模板库页面：`src/app/templates/page.tsx` / `gallery.tsx` / `phone-preview.tsx` /
  `templates.module.css`。
- 编辑器接入：`src/app/projects/[id]/editor.tsx`（`<select>` 改为按钮 + 跳转）。
- 导航：`src/app/app-shell.tsx` 增加「模板库」项。
- 接口复用：模板库页读 `GET /api/layout-templates` 拿清单、调 `POST /api/wechat/theme` 应用、
  复用 `GET /api/wechat/preview` 渲染示例稿，**不新增接口**。
- 权威设计规则：`docs/design/template-gallery.md`。
