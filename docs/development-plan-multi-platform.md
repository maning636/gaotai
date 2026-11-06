# 稿台 · 多平台排版与发布增强 — 开发计划

> 参考项目：[obsidian-wechat-converter](https://github.com/DavidLam-oss/obsidian-wechat-converter)（MIT, Copyright (c) 2026 林小卫 DavidLam）
> 本计划复刻其核心能力，用稿台的技术栈（Electron + Next.js）重新实现。
> MIT 协议要求保留版权声明：最终产物 LICENSE 中注明"部分设计参考 obsidian-wechat-converter (MIT, DavidLam)"。

---

## 现状对比

| 能力 | obsidian-wechat-converter | 稿台现状 | 差距 |
|---|---|---|---|
| Markdown → 微信排版 | ✅ CSS 渲染 | ✅ 模板系统（21套排版包） | 已有，但缺抗清洗管线 |
| 手机预览 | ✅ 仿真 iPhone | ✅ PhonePreview | 已有 |
| 微信草稿 API | ✅ 多账号 + 覆盖更新 | ✅ 单账号，每次新建 | 缺覆盖更新 + 多账号 |
| 知识卡片 | ✅ 6+11套主题切图导出 | ❌ | 全缺 |
| 抗清洗渲染 | ✅ LaTeX SVG / Mermaid 转图 | ❌ | 全缺 |
| 浏览器扩展分发 | ✅ WS 桥接多平台 | ❌ | 全缺 |
| AI 配图 | ✅ 内置工作台 | ❌（通过外链） | 全缺 |
| 本地写作工序 | ❌ | ✅ 四道工序 | 稿台优势 |

## 开发顺序（按依赖关系排列）

1. **模块1：CSS 排版主题移植** — 卡片主题 + 长文主题 + 自定义 CSS 管线
2. **模块4：微信草稿覆盖更新** — 覆盖更新 + 多账号 + 图片并发
3. **模块3：抗清洗渲染管线** — LaTeX SVG / Mermaid 转图 / Mac 代码块
4. **模块2：知识卡片模式** — 切图导出 PNG（依赖模块1的卡片主题）
5. **模块6：AI 配图工作台** — AI 生图 + Unsplash 搜索
6. **模块5：浏览器扩展分发** — 本地 WS 桥接 + 多平台推送

---

## 模块1：CSS 排版主题移植

### 目标
- 移植 6 套经典卡片主题 + 11 套 mood 色板
- 移植 8 套长文排版主题
- 移植自定义 CSS 注入管线（postcss 安全清理 + juice 内联）

### 实现方案

#### 1.1 卡片主题数据
- 新建 `src/lib/card-themes/classic-themes.ts`：6 套主题（simple-white / gradient-blue / dark-gold / neon-purple / forest-green / rose-gold）
- 新建 `src/lib/card-themes/mood-palettes.ts`：11 套 mood 色板
- 新建 `src/lib/card-themes/index.ts`：合并导出 `THEMES` map + `getCardTheme(id)` + `buildCardPageCss(theme, typography)`
- 每套主题是纯数据对象：`{id, name, tokens:{background, cardBackground, accentColor, ...}, fontSerif?: boolean}`
- `buildCardPageCss` 返回以 `.icard` 为根的 scoped CSS 字符串

#### 1.2 长文排版主题
- 扩展 `src/lib/layout-template.ts`，增加 8 种主题配置（github/wechat/serif/paper/grid/typo/media/colorful）
- 每套含 `lineHeight / paragraphGap / heading 样式 / blockquoteStyle / tableHeaderBg` 等
- `getStyle(tagName)` 按标签名返回内联样式字符串

#### 1.3 自定义 CSS 管线
- 新建 `src/lib/custom-css/source.ts`：从用户设置读取 CSS 文本
- 新建 `src/lib/custom-css/compiler.ts`：用 `postcss` 做 AST 安全清理 + 选择器作用域改写（根选择器 `.gt-article-root`）+ 伪元素提取
- 新建 `src/lib/custom-css/inliner.ts`：用 `juice` 把 scoped CSS 内联到 HTML
- fail-open：CSS 失败时返回原 HTML，不中断预览

### 新增依赖
- `postcss` + `postcss-selector-parser` + `postcss-value-parser`
- `juice`

### 涉及文件
- 新建：`src/lib/card-themes/*.ts`、`src/lib/custom-css/*.ts`
- 修改：`src/lib/layout-template.ts`（增加长文主题）
- 修改：排版预览页 `src/app/projects/[id]/preview/panel.tsx`（支持自定义 CSS）

### 验证标准
- 6 套卡片主题 + 11 套 mood 色板可渲染预览
- 8 套长文主题可应用到现有稿件
- 自定义 CSS 注入后预览正确，非法 CSS 不崩溃
- tsc + lint + 492 测试全通过

---

## 模块4：微信草稿覆盖更新

### 目标
- 同一篇文章再次推送时，覆盖更新已有草稿（不重复创建）
- 支持多账号切换（最多 5 个公众号）
- 图片并发上传（并发 3）+ 指纹缓存 + 熔断

### 实现方案

#### 4.1 草稿关联缓存
- 新建 `src/lib/wechat/draft-cache.ts`：
  - 存储结构：`{[projectId+accountId]: {mediaId, index, title, updatedAt}}`
  - 存在 SQLite（`gaotai.sqlite` 的新表 `wechat_draft_cache`）
  - 推送前查缓存：命中 → `updateDraft(mediaId, index, article)`；未命中 → `createDraft(article)` + 写回缓存

#### 4.2 多账号
- 修改微信配置：从单账号改为 `wechatAccounts[]`（每项 `{id, name, appId, appSecret}`）
- 修改 `/api/wechat/config` 和 `/api/wechat/test`：支持按 `accountId` 查询
- 修改排版预览页：② 公众号通道区域增加账号选择下拉

#### 4.3 图片并发上传
- 修改 `src/lib/wechat/draft.ts`（或对应文件）：
  - 提取唯一图片 URL → 并发上传（并发数 3）
  - 每图计算 fingerprint（SHA-256），命中缓存直接复用
  - 致命错误（配额超限）熔断停止；非致命失败用黄色占位图
  - 给 img 补 `data-s` / `data-type` 属性

#### 4.4 createDraft 不自动重试
- `createDraft` 调用**不包 requestWithRetry**（避免请求成功响应丢失时重复建草稿）
- `updateDraft` 和 `uploadImage` 可以重试

### 涉及文件
- 新建：`src/lib/wechat/draft-cache.ts`、`src/lib/wechat/concurrency.ts`
- 修改：`src/lib/wechat/draft.ts`、`src/lib/wechat/api.ts`（或对应文件）
- 修改：`src/app/api/wechat/draft/route.ts`
- 修改：排版预览页 `panel.tsx`（账号选择）
- 修改：`/wechat` 配置页（多账号管理）

### 验证标准
- 同一稿件推两次，第二次是更新不是新建
- 多账号切换正常
- 图片上传并发 3 + 缓存命中不重复上传
- tsc + lint + 全测试通过

---

## 模块3：抗清洗渲染管线

### 目标
- LaTeX 公式 → 纯矢量 SVG（微信不清洗）
- Mermaid 图表 → 高清 PNG
- 代码块 Mac 风格（用 `<section>` 不用 `<span>`）
- 宽表格横向滑动容器

### 实现方案

#### 3.1 LaTeX 公式
- 新增依赖：`mathjax-full`
- 新建 `src/lib/render/math.ts`：
  - 用 MathJax 的 `TeX` 输入 + `SVG` 输出 + `liteAdaptor`
  - 仅引入 13 个高频核心宏包（base/ams/newcommand/noerrors/...）
  - `renderMath(formula, displayMode)` → SVG 字符串
- 修改 `src/lib/markdown.ts`（或 `renderTemplatePreview`）：在 Markdown → HTML 管线中注入公式渲染

#### 3.2 Mermaid 转图
- 新增依赖：`mermaid`
- 新建 `src/lib/render/mermaid.ts`：
  - `renderMermaidToSvg(source)` → 调 `mermaid.render(id, source)` 得 SVG
  - `rasterizeSvgToPng(svg, scale)` → Canvas API 转 PNG dataURL
  - 注入 `%%{init}%%` 兼容主题保证微信端配色一致
- 修改 Markdown 渲染管线：识别 ```mermaid 代码块 → 转图

#### 3.3 Mac 风格代码块
- 修改 `src/lib/markdown.ts` 的代码块渲染：
  - 用 `<section>` 做红绿灯圆点（不用 `<span>`，微信会过滤空 span）
  - GitHub Dark 配色（背景 `#0d1117`、文字 `#f0f6fc`）
  - 行号列 + 代码内容 flex 布局
  - 用 `highlight.js` 做语法高亮，内联样式
- 新增依赖：`highlight.js`

#### 3.4 横向滑动容器
- 修改模板渲染：宽表格自动包 `<div style="overflow-x:scroll">`
- 修改 `src/lib/markdown.ts`：表格宽度检测 + 包裹逻辑

### 涉及文件
- 新建：`src/lib/render/math.ts`、`src/lib/render/mermaid.ts`、`src/lib/render/svg-rasterizer.ts`
- 修改：`src/lib/markdown.ts`（代码块 + 表格 + 公式注入）
- 修改：排版预览页（展示效果）

### 验证标准
- `$E=mc^2$` 渲染为 SVG，复制到公众号不被清洗
- ```mermaid 代码块渲染为 PNG
- 代码块有 Mac 红绿灯 + GitHub Dark 配色
- 宽表格有横向滚动
- tsc + lint + 全测试通过

---

## 模块2：知识卡片模式

### 目标
- Markdown → 多页知识卡片 → 批量导出 PNG
- 3 种比例（3:4 / 3:5 / 9:16）
- 6 套经典主题 + 11 套 mood 色板（来自模块1）
- 封面独立选图
- 离屏 DOM + modern-screenshot 截图

### 实现方案

#### 2.1 卡片渲染引擎
- 新增依赖：`modern-screenshot@4`
- 新建 `src/lib/card/render-engine.ts`：
  - 布局主循环：`measure → plan → assemble → 溢出核验收缩重排`（最多 N 轮）
  - 分页：`createCardPagePlan` 把文档块切成多页
  - 比例预设：`RATIO_PRESETS = {"3:4":{w:375,h:500}, "3:5":{w:375,h:625}, "9:16":{w:375,h:667}}`
- 新建 `src/lib/card/assembly.ts`：DOM 装配（`.icard-page` 外层 + `.icard-content` 内卡）
- 新建 `src/lib/card/capture.ts`：`capturePage(root)` → `domToBlob(root, {scale})` → PNG

#### 2.2 离屏容器
- 新建 `src/lib/card/offscreen.ts`：
  - 创建 `position:fixed + visibility:hidden` 容器（禁止 `display:none`）
  - 挂载到 document.body
  - 截图后清理

#### 2.3 批量导出
- 新建 `src/lib/card/exporter.ts`：
  - 串行逐页截图 → PNG 文件
  - 进度回调
  - 失败页标记继续，路径冲突停止
- 新建 `src/app/api/card/export/route.ts`：后端接收 PNG 数据写盘

#### 2.4 封面选图
- 新建 `src/lib/card/cover-model.ts`：从稿件属性派生封面字段
- 支持：本地图片 / Unsplash（来自模块6）/ AI 生图（来自模块6）

#### 2.5 前端页面
- 新建 `src/app/projects/[id]/cards/page.tsx`：卡片模式页面
  - 左侧：主题选择 + 比例选择 + 排版 Token 调整 + 封面选图
  - 右侧：实时预览（多页卡片缩略图）
  - 底部：单张复制 / 批量导出 PNG
- 新建 `src/app/projects/[id]/cards/cards.module.css`

### 涉及文件
- 新建：`src/lib/card/*.ts`、`src/app/projects/[id]/cards/*`
- 新增依赖：`modern-screenshot@4`

### 验证标准
- 一篇稿件可切换到卡片模式
- 选择主题 + 比例后实时预览多页卡片
- 单张复制到剪贴板
- 批量导出 PNG 到本地文件夹
- tsc + lint + 全测试通过

---

## 模块6：AI 配图工作台

### 目标
- AI 生图（OpenAI Images 兼容接口）
- 6 种风格预设（3D粘土 / 极简矢量 / 赛博朋克 / 温暖治愈 / 编辑杂志 / 自定义）
- Unsplash 图库搜索
- 封面选图集成

### 实现方案

#### 6.1 AI 生图
- 新建 `src/lib/ai-image/generate.ts`：
  - `generateImage(provider, prompt, aspectRatio)` → POST `/images/generations`
  - 支持异步任务轮询（`/tasks/{taskId}`，2.5s 间隔，90s 超时）
  - 结果转 base64
- 新建 `src/lib/ai-image/styles.ts`：6 种风格的 prompt 模板
- 新建 `src/lib/ai-image/topic-extract.ts`：用文本 AI 从稿件摘要提炼主题关键词

#### 6.2 Unsplash 搜索
- 新建 `src/lib/ai-image/unsplash.ts`：
  - `searchPhotos(query, page, orientation)` → GET `https://api.unsplash.com/search/photos`
  - `randomPhotos(count, orientation)` → GET `/photos/random`
  - `downloadAsBase64(url)` → 拉原图转 base64
  - `trackDownload(downloadLocation)` → 上报（Unsplash 协议要求）

#### 6.3 后端 API
- 新建 `src/app/api/ai-image/generate/route.ts`：代理 AI 生图（隐藏 apiKey）
- 新建 `src/app/api/ai-image/unsplash/route.ts`：代理 Unsplash 搜索（隐藏 apiKey）
- Unsplash API Key 存在 `.env` 的 `UNSPLASH_ACCESS_KEY`

#### 6.4 前端 UI
- 新建 `src/app/projects/[id]/cards/media-picker.tsx`：
  - Tab 1：AI 生图（风格选择 + 主题提炼 + 生成 + 画廊对比）
  - Tab 2：Unsplash 搜索（热门标签 + 3列网格 + 30分钟缓存）
  - Tab 3：本地图片

### 涉及文件
- 新建：`src/lib/ai-image/*.ts`、`src/app/api/ai-image/*`、`src/app/projects/[id]/cards/media-picker.tsx`

### 验证标准
- AI 生图：选风格 → 生成 → 预览 → 选为封面
- Unsplash：搜关键词 → 网格展示 → 选图
- apiKey 不暴露到前端
- tsc + lint + 全测试通过

---

## 模块5：浏览器扩展分发

### 目标
- 本地 WebSocket 服务器（`127.0.0.1:9527`）
- 浏览器扩展连接后可推送草稿到知乎/掘金/CSDN/小红书等
- JSON-RPC 协议（兼容 obsidian-wechat-converter 的扩展）

### 实现方案

#### 5.1 WS 服务器（Electron 主进程）
- 新建 `src/lib/bridge/ws-server.ts`：
  - 手写 WebSocket 握手（`createWebSocketAcceptKey` + 帧解析 + 文本帧编码）
  - 绑定 `127.0.0.1:9527`
  - 不依赖 `ws` 包（与参考项目一致，减依赖）
- 新建 `src/lib/bridge/protocol.ts`：
  - `hello` 握手（token 校验 + pairing）
  - JSON-RPC 方法：`listPlatforms` / `checkAuth` / `syncArticle` / `enqueueSyncArticle` / `getSyncTask`
  - 会话上限 4 客户端

#### 5.2 Electron 主进程集成
- 修改 `electron/main.js`：
  - 启动时创建 WS server
  - 窗口关闭时清理
  - 端口冲突时换端口（9527 被占 → 9528 → ...）

#### 5.3 前端发布弹窗
- 新建 `src/app/publish/multi-platform/page.tsx`：
  - 平台选择墙（知乎/掘金/CSDN/小红书/飞书等）
  - 扩展连接状态指示
  - 推送进度 + 结果展示
- 新建 `src/app/publish/multi-platform/multi-platform.module.css`

#### 5.4 浏览器扩展（独立产物）
- 新建 `extension/` 目录（Chrome Manifest V3 扩展）
  - `manifest.json`：声明权限（activeTab, tabs, scripting）
  - `background.js`：WS 客户端，连 `ws://127.0.0.1:9527`
  - `content-script.js`：注入各平台编辑器，填充标题 + 正文 + 图片
  - 每个平台的适配器：知乎/掘金/CSDN/小红书各自处理编辑器 DOM

### 涉及文件
- 新建：`src/lib/bridge/*.ts`、`src/app/publish/multi-platform/*`、`extension/*`
- 修改：`electron/main.js`

### 验证标准
- 浏览器扩展安装后能连上稿台 WS server
- 在稿台选稿件 + 选平台 → 扩展自动往各平台编辑器填内容
- 扩展未连时提示"请安装浏览器扩展"
- tsc + lint + 全测试通过

---

## 全局注意事项

### 版权声明
- 在 `LICENSE` 文件追加："部分设计参考 obsidian-wechat-converter (MIT, Copyright (c) 2026 林小卫 DavidLam)"
- 在"关于"页面注明

### 新增依赖汇总
| 包 | 用途 | 模块 |
|---|---|---|
| `postcss` + `postcss-selector-parser` + `postcss-value-parser` | 自定义 CSS 安全清理 | 1 |
| `juice` | CSS 内联到 HTML | 1 |
| `mathjax-full` | LaTeX → SVG | 3 |
| `mermaid` | Mermaid 渲染 | 3 |
| `highlight.js` | 代码语法高亮 | 3 |
| `modern-screenshot@4` | DOM → PNG 截图 | 2 |
| `@noble/hashes` | SHA-256（WS 桥接认证 + 图片指纹） | 4, 5 |

### 版本规划
- v0.4.0：模块1（CSS 主题）+ 模块4（草稿覆盖更新）
- v0.5.0：模块3（抗清洗渲染）
- v0.6.0：模块2（知识卡片）
- v0.7.0：模块6（AI 配图）
- v0.8.0：模块5（浏览器扩展分发）

### 子代理执行规范
- 每个模块用子代理实现，主代理审核
- 子代理模型：`SenseNova/sensenova-6.8-flash-lite`（6.8 模型）
- 每个模块完成后：tsc + lint + 全测试通过 + 截图验证
- 提交信息结尾加 `AI-Model: Kimi-Code`
- 不 `git push`，不 `npm install` 未授权
