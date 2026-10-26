# 模板画廊与手机预览 · 设计规则

> 目标：把「选排版」从编辑器里的下拉框，改成**独立的模板库存页面**——平铺卡片看排版，
> 右侧手机里看效果；同时把 WeDraft（MIT）的 7 套模板纳入随包模板库。
>
> 本文是执行规则：子代理按本文实现，主代理按本文验收。

## 1. 现状与问题

- 编辑器正文页的排版选择是 `<select>`（`src/app/projects/[id]/editor.tsx` 约 1025 行），
  只能看到模板名字，看不到效果。
- 已有 `/layout` 页负责「导入样式包 → 取舍部件 → 编辑色值 → 存为模板」，是**管理页**，
  不适合做「快速挑一套」的浏览页。
- 随包模板机制已存在：往 `resources/layout-packs/*.json` 放一份 JSON，就自动出现在
  `listTemplates()` 里（id = `builtin:<文件名>`），无需改代码。

## 2. 目标形态（验收基准）

### 2.1 新页面 `/templates`（模板库）

两栏布局（宽屏）：

- **左/主区：平铺卡片网格**
  - 自适应列：`repeat(auto-fill, minmax(220px, 1fr))`，卡片可多列排布，不出现下拉框。
  - 每张卡：模板名、来源徽标（内置 / 随包 / 我的）、一句描述、缩略预览（示例稿按该模板
    渲染后等比缩小、裁切显示）、当前使用标记。
  - 点击卡片 = 选中，**只更新右侧手机预览，不立即应用**。
- **右/预览栏：手机（sticky）**
  - iPhone 外形：屏幕 440×956（外框 456×972），按容器高度自动缩放（fit）；
    顶部状态栏（时间 9:41、信号/WiFi/电池）+ 微信顶栏（返回箭头 + 「公众号」+ 更多）。
  - 屏幕内容：选中模板渲染同一份示例稿，可在手机内滚动。
  - 底部操作：「使用这套」；带 `?project=<id>` 时点击后应用到该稿件并跳回编辑器。
- 窄屏（<1024px）：手机预览折叠到卡片列表下方（或弹层），不遮挡卡片。

### 2.2 编辑器接入

- 正文页移除 `<select>`，改为一行：「排版：当前模板名」+ 「换排版」按钮。
- 按钮跳 `/templates?project=<id>&from=editor`。
- 模板库「使用这套」后回到 `/projects/<id>`，编辑器按既有逻辑重新读取该稿件的模板。

### 2.3 页面关系（最终形态：合并为单页双 Tab）

- **一个页面 `/templates`，两个 Tab**：
  - 「模板库」：浏览、手机预览、应用（本文 §2.1）。
  - 「模板管理」：导入样式包、取舍部件、改色值、保存/删除（原 `/layout` 面板，逻辑不变）。
- 默认进「模板库」；`?tab=manage` 直接落在管理面板。
- `/layout` 保留为重定向到 `/templates?tab=manage`，旧链接与书签不失效。
- 导航栏只保留「模板库」，不再并列「排版」——同一件事不应该有两个入口。

## 3. WeDraft 模板接入规则

### 3.1 来源与许可

- 来源：`https://github.com/pafa/WeDraft`（MIT，Copyright (c) 2026 pafa and WeDraft contributors）。
- 纳入 7 套：`reading-editions.ts` 的 5 套（plain-paper 素笺 / ink-journal 墨刊 /
  jade-notes 青岚 / blueprint 蓝图 / cinnabar 朱砂）+ `default-business.json`（小哈公社）+
  `next-edition.json`（小哈公社 New）。
- 义务：根 `NOTICE.txt` 增加 WeDraft 条目；`resources/layout-packs/LICENSE-wedraft` 放 MIT 原文；
  `resources/layout-packs/SOURCE-wedraft.json` 记录 repo / commit / license / 转换说明。
  模板卡片显示「WeDraft · 素笺」这类来源前缀。

### 3.2 转换规则（WeDraft「元素 → CSS」→ 稿台「部件 → HTML」）

生成物：`resources/layout-packs/wedraft-<id>.json`，schema 与本目录现有包一致
（`name` / `description` / `source` / `vars` / `parts`）。

| WeDraft 键 | 稿台部件 | 说明 |
| --- | --- | --- |
| `article` / `body` | `root` | 整篇外壳：字号、行距、颜色、字距、对齐、背景 |
| `heading2` | `heading` | `<{{tag}}>`，保留字号/字重/颜色/边距 |
| `heading3` | `heading3` | 同上 |
| `heading4`（如有） | `heading4` | 同上 |
| `paragraph` | `paragraph` | `<p>` |
| `strong` / `em` / `link` | `strong` / `em` / `link` | 链接样式含下划线/颜色 |
| `inlineCode` / `code` | `inlineCode` / `code` | 代码块保留底色/字体/圆角 |
| `quote` / `quoteMark` | `quote` | 竖线/底色/内边距；`quoteMark` 的装饰字符第一版不引入（记录为已知限制） |
| `list` / `listItem` | `list` / `listItem` | 有序/无序共用 |
| `table` / `tableHead` / `tableCell` | 同名部件 | 表头底色、边框、对齐 |
| `image` / `imageCaption` | `image` | 图注第一版并入图片块（`{{caption}}` 若模型支持则用，否则不输出）；记录限制 |
| `divider` | `divider` | |
| `headingNumber` / `headingText` | — | 稿台部件模型无「章节序号」层，第一版不引入（已知限制） |
| `referenceTitle` / `referenceNumber` 等 | — | 无对应部件，忽略并记录 |

**样式收敛**：CSS 对象按 `property: value` 拼成内联样式；只允许通过
`src/lib/layout-template.ts` 的清洗器白名单。不被支持的属性直接丢弃，转换脚本统计
warnings 并打印；**生成物必须能被 `parseLayoutPack()` 解析且 0 warnings**（否则视为失败）。

**色值变量化**：`accent` ← `accentColor`；`text`/`heading`/`muted`/`border`/`surface`/
`codeBg`/`codeText` 从对应元素推导。HTML 里用 `{{var}}` 引用，不散落硬编码色值
（模板卡片的缩略图与手机预览因此能随变量一致）。

**命名**：id 固定 `builtin:wedraft-<原 id>`；name 用「WeDraft · <中文名>」；
description 保留原文并加一行「源自 WeDraft（MIT）」。

**脚本**：`scripts/convert-wedraft-templates.mts`，用 tsx 执行；参考仓库路径由参数给
（默认 `.tmp/refs/WeDraft`），可重复运行；生成物入库，脚本入库，**不依赖 .tmp 下的临时文件
参与构建**。

### 3.3 测试

- `src/tests/wedraft-convert.test.ts`：
  - 7 套模板全部转换成功；
  - 每套 `vars` 的 accent 与源模板一致；
  - 每套 `parts` 至少包含 root/heading/paragraph/quote/list/code/table 关键部件；
  - `parseLayoutPack()` 对 7 份生成物 0 warnings；
  - 选 2 套做关键色值断言（素笺、蓝图）。
- 生成物进入现有 `resources.test.ts` 的随包资源断言范围（若该测试对数量有断言，需同步更新）。

## 4. 分工与文件归属（避免并行冲突）

| 子代理 | 负责文件 |
| --- | --- |
| A（数据） | `scripts/convert-wedraft-templates.mts`、`resources/layout-packs/wedraft-*.json`、`LICENSE-wedraft`、`SOURCE-wedraft.json`、`NOTICE.txt`、`src/tests/wedraft-convert.test.ts` |
| B（界面） | `src/app/templates/page.tsx`、`src/app/templates/gallery.tsx`、`src/app/templates/phone-preview.tsx`、`src/app/templates/templates.module.css`、`src/app/app-shell.tsx`（导航）、`src/app/projects/[id]/editor.tsx`（下拉替换） |
| C（文档） | `docs/architecture/decisions/0004-template-gallery.md`、`docs/spec.md` §1.4/§3.6、`docs/使用手册.md`、`README.md`（文档导航） |

- A、B、C 互不写对方文件；**都不做 git 操作**，不推送。
- B 依赖 A 的生成物只体现在运行时（包自动出现在清单里），开发期可用现有 21 套包自测，
  A 完成后 7 套新包自动出现，无需改 B 的代码。

## 5. 验收（主代理执行）

1. `npm run verify` 四道门全绿（lint / typecheck / 373+ 测试 / deps-gate）。
2. `npm run dev` 起服务，用内置浏览器打开 `/templates`：
   - 卡片平铺（无 `<select>`）；右侧手机可见；
   - 点不同卡片，手机内渲染结果随之变化；
   - 带 `?project=<id>` 时「使用这套」能写回并跳回编辑器；
   - 编辑器里排版选择已是按钮而非下拉。
3. 截图留档到 `.tmp/screens/`（不入库）。
4. 生成物抽查：7 份 JSON 可读、0 warnings、MIT 署名与 SOURCE 齐全。
5. 通过后本地提交（按用户要求暂不推送）。

## 2.4 模板管理 Tab 的三栏布局（2026-10-26 修订）

用户反馈原管理页「左边一个大空、模板一行一个大条、右侧只有配置没有手机」。现已重做：

- **左栏（约 280px）**：模板**小方块瓦片**两列排列（名称 + 来源徽标），区域独立滚动；
  顶部是「导入样式包」入口。瓦片只负责选择，不再塞复制/删除按钮。
- **中栏（自适应）**：选中模板的配置——名称/说明（自定义模板）、复制一份来改、颜色变量、
  部件勾选与 HTML 编辑、保存/删除。中栏独立滚动。
- **右栏（约 470px，sticky）**：手机预览，渲染的是**正在编辑的草稿**，改色/增删部件即时生效；
  管理场景不显示「使用这套」（`showApply={false}`），手机高度按视口收敛。
- 断点：<1180px 手机移到下方；<860px 全部单栏。

同时修了图片链路：清洗器放行 `{{src}}` 占位符（此前会被整条丢掉，导入模板的图片全为空），
预览示例稿加入本地生成的配图（data URI，不依赖网络）。
