# 稿台 · 产品与接口规格

本文件是「稿台」（gaotai）的**权威规格**。所有实现以本文件为准；本文件与任何第三方项目无关，
是从零写就的产品定义。

---

## 1. 产品定位

稿台是一个**本地运行**的公众号写作工作台（桌面客户端）。创作者把素材丢进来，AI 分四道工序
把它变成一篇可发布的稿子；每道工序都可以追问、都可以手改；手改的差异被记下来，反过来影响
下一稿的语气。

**它不是**：一个通用的 AI 聊天框。它有固定的工序、有确认闸门、有可积累的个人风格资产。

### 1.1 四道工序

| 阶段 | key | 产出 | 闸门 |
| --- | --- | --- | --- |
| 材料解读 | `brief` | 硬事实 / 作者判断 / 待核实 / 缺口 / 可切角度 | 用户签字 → 进入 `angle` |
| 选题与方向 | `angle` | 3 个可选角度（主张、读者、时机、反对意见、风险） | 选定一个 → 进入 `outline` |
| 写作大纲 | `outline` | 全文主张 + 全文推进线 + 说话位置 + 分段（推进、目的、素材、形式） | 签字 → 进入 `article` |
| 文章正文 | `article` | 完整 Markdown | 定稿 → 走微信闭环 |

未确认（`draft`）的阶段产出**不会**作为上下文注入后续阶段，避免把草稿当定稿。

### 1.1.1 大纲的三个头

大纲开头有三块，它们是正文阶段的骨架：

| 块 | 形状 | 作用 |
| --- | --- | --- |
| 全文主张 | `**全文主张**：…` 一行 | 这篇稿子最终要落到的判断 |
| 全文推进线 | `**全文推进线**：…` 一行 | 串起全文的那条线；每段负责让它挪一点 |
| 说话位置 | `**说话位置**` + 四行 | 谁在说 / 凭什么知道 / 他的判断 / 读者的追问 |

**说话位置四行必须齐了**才注进正文上下文（`isVoicePositionComplete`）；缺行就不给，
正文退回「按一个真正干过这行的人写」，稿台不替模型编。
分节生成时（每节一个独立请求）同样带着它，否则每节自己挑一个语气、拼起来像几个人写的。

大纲的三种写法（结构式 / 散文式 / markdown 标题）都要能解析，
段落标题的装饰（引用块 / `#` / 粗体 / 列表符）在切段之前统一剥掉。

### 1.2 风格记忆

用户在界面上手动改 AI 产出时，系统把「改前原文」和「改后原文」都写进 `edits` 表。
这些编辑记录是风格画像的**唯一证据来源**——AI 写了什么不算数，人改成什么样才算数。

编辑记录累积到 `MIN_EDITS_FOR_PROFILE`（6）条后，可从真实差异反推出作者习惯，生成一份
markdown 画像，注入到之后每一阶段的 system 提示里。

画像是**启发式规则分析**的产物（纯本地统计，不调用大模型）。

### 1.3 微信闭环

Markdown 正文 → 公众号兼容 HTML（行内样式，无 class）→ 草稿箱 → 用户在公众号后台预览 → 手动发布。
另提供已发布文章同步与图文数据统计。

### 1.4 排版模板

一套排版 = **一组部件** + **一组色值**。这是「可沉淀 / 可取舍 / 可迭代」的落点。

| 概念 | 定义 |
| --- | --- |
| 部件（part） | 标题、正文段落、引用、代码块、表格、结尾语……每个有固定的 `key`、中文名与落位 |
| 落位（placement） | `root`（整篇外壳）/ `head`（整篇最前）/ `inline`（正文中间）/ `tail`（整篇最后） |
| 部件 html | 一段 HTML 模板。`{{content}}` 是内容占位（**最后填**），`{{变量名}}` 取模板变量或渲染上下文 |
| 变量（vars） | 13 个内置色值（`text` `heading` `muted` `codeBg` `codeText` `border` `quoteBar` `surface` `codeHeader` `codeShadow` `dot1` `dot2` `dot3`）。样式包可自带额外变量 |
| 内置纯配色 | 三套配色（`builtin:default` / `builtin:paper` / `builtin:mist`）。**只有 vars，parts 为空**，即「所有部件走默认样式、颜色取自这套配色」。只读 |
| 随包样式包 | `resources/layout-packs/*.json`，28 套（21 套 rico-md 翻译 + 7 套 WeDraft 翻译）。**内置模板**，只读、可复制 |
| 用户模板 | 存在库里，可改可删。id 形如 `lay_<hex>` |

**标题分三级**：`title`(h1) / `heading`(h2) / `heading3`(h3) / `heading4`(h4)。
主题给每一级标题配的样式往往差很多（字号、字重、边框、斜体、大写），
合并成一个部件会把层次抹平，所以按级拆开。

**保留名**：`tag` `headingSize` `level` `start` `href` `src` `alt` `imageStyle` `thead` `tbody`
`dots` `langCaption` `langAttr` `lang` `content` 是**渲染上下文占位符**，不是变量——
用户拿它们当变量名会被上下文顶掉，所以直接不给留。

**取舍语义**（部件在模板 `parts` 里且 `enabled`）：

| 落位 | 勾上 | 不勾 |
| --- | --- | --- |
| `inline` | 用模板里的 html | 退回内置默认样式（内容不丢） |
| `head` / `tail` | 整块输出 | **整块不输出** |

**渲染顺序**：`{{content}}` 最后填。这样正文里出现 "{{text}}" 这种字样不会被当成变量替换掉。

**样式包**（外部来的 JSON，一份一个文件）：

- 只做三件事：**解析 → 清洗 → 列出部件让人勾**。**导入接口不落库**——
  一把导入就存库，等于把包作者的偏好硬塞给用户。
- 清洗（外部包的 html 等于外部输入）：标签与属性走白名单；样式值不许出现
  `url()` / `expression` / `javascript:` / `@import`；图片地址只认 `http(s)`、本机图片接口与 `data:image`；
  `href` 只认 `http(s)` 与渲染占位符；不在白名单里的标签**丢标签、留内容**。
- **标签名位置允许 `{{tag}}`**（唯一的受控占位符）：部件模板需要知道「这里放什么标签」。
  不放行的话，整段 html 会被当成纯文本转义——导入明明「成功」，预览里却是一堆字面量标签。
- **样式值里的 `{{变量}}` 放行**（名字限死字母数字下划线）：
  模板变量是稿台自己的东西，丢掉整条声明会让导入的部件**悄悄没了样式**且不报错。
- 不认识的部件直接忽略，并在 `warnings` 里点名是哪几个。

**变量与固定文本的转义责任**：`ctx`（地址、alt、拼好的 html）由调用方转义，稿台不重复转义；
`vars`（模板自己的值，可能是导入的）由稿台补一次转义——一个带引号的色值就能把 `style` 属性截断。
头尾部件的「固定文本」按**纯文本**处理，要放标记就写在部件的 html 里。

**界面只列真正用到的变量**：色值表按「部件 html 里真的写了 `{{xxx}}`」过滤。
随包主题自带 3–8 个变量，补齐成 13 个只会多出一堆「改了没反应」的空框。

### 1.4.1 随包主题（rico-md）

排版模板页「随包主题」那一组，是从 `ricocc/rico-md`（MIT）翻译而来的 21 套。
翻译方式与授权边界见 `resources/layout-packs/SOURCE.json` 与 README「来源与授权」一节：

- 上游是「选择器 → CSS 声明块」，这里按部件模型重新组装 HTML；
- 去掉 `!important` 与字体栈里的双引号（两者都会被清洗器整条丢弃）；
- 颜色提取成变量；h2/h3/h4 拆成三个部件。
- 上游另有 12 套 AGPL-3.0-or-later 的主题（`gzh-design-skill` 主题体系），**整套不引入**。

### 1.4.2 随包主题（WeDraft）

另有 7 套随包主题是 [pafa/WeDraft](https://github.com/pafa/WeDraft)（MIT，
Copyright (c) 2026 pafa and WeDraft contributors）的翻译，覆盖 `reading-editions.ts` 的 5 套
（素笺 / 墨刊 / 青岚 / 蓝图 / 朱砂）+ `default-business.json`（小哈公社）+
`next-edition.json`（小哈公社 New）。id 命名 `builtin:wedraft-<原 id>`，name 用「WeDraft · <中文名>」；
MIT 版权与许可声明随包保留在 `resources/layout-packs/`（`LICENSE-wedraft` + `SOURCE-wedraft.json`），
汇总见根 `NOTICE.txt`。转换方式与已知限制见 §3.6.1。

---

## 2. 数据模型

数据库：SQLite（`better-sqlite3`），文件位于 `<数据根>/data/gaotai.sqlite`。WAL 模式。

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `projects` | 一篇稿子 | `id` `title` `topic_id` `stage` `created_at` `updated_at` |
| `stage_results` | 每道工序的产出 | `project_id` `stage` `content` `status(draft\|confirmed)` |
| `messages` | 阶段内的往返对话 | `project_id` `stage` `role(user\|assistant)` `content` |
| `edits` | 人工修改证据 | `project_id` `stage` `before_text` `after_text` |
| `style_profiles` | 每个专题一份画像 | `topic_id`(UNIQUE) `profile` |
| `assets` | 素材登记 | `project_id` `kind(text\|file\|image\|url)` `name` `body` |
| `wx_preferences` | 公众号偏好 | `key` `value`（含 `theme` 与 `template_id`） |
| `layout_templates` | 用户自己的排版模板 | `id` `name` `description` `source` `template`(JSON) |

所有 SQL 收敛在 `src/lib/repo.ts`，上层只调函数。

---

## 3. HTTP 接口

全部接口 `runtime = "nodejs"`，全部需要登录（`requireAuth()` 返回 401）。
返回体统一 `{ ... }` 成功 / `{ error: string }` 失败。

### 3.1 认证

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/auth/session` | `{ token }` 启动令牌 | `{ ok: true, authenticated: true }`；令牌不对 403 |
| POST | `/api/auth/login` | `{ password }` | `{ ok: true }`；失败 401 + `{ error }` |
| POST | `/api/auth/logout` | — | `{ ok: true }` |
| GET | `/api/auth/session` | — | `{ authenticated: boolean }` |

**普通用户不面对任何登录界面。**

桌面客户端每次启动随机生成一个**启动令牌**，只通过环境变量 `GAOTAI_BOOT_TOKEN`
交给后端子进程（**不落盘、不进 `.env`**），窗口打开前用 `POST /api/auth/session` 换一个会话。
于是：

- 双击即用，没有口令框、没有激活码；
- 30 天会话过期对用户不可见——每次启动都自动续上；
- 浏览器里的网页拿不到启动令牌（后端只认进程环境变量里的那一份），所以这条路依然受保护。

**口令降级为机器内部凭证**：`POST /api/auth/login` 只服务「浏览器直接访问 `127.0.0.1`」这一种场景。
桌面端的登录页会自动用本机口令进入；安全页的「退出登录」在桌面端换成一句说明
（客户端每次启动都会自动换会话，退出只是刷新）。

登录失败要追加记录到 `<数据根>/data/login-failures.jsonl`（每行一条 JSON：
`{ at, ip, ua }`），并保留最近 200 条。

### 3.2 专题与风格
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/topics` | `{ topics: Topic[] }`，`Topic = { id, name, description, audience, tone, rules, source, builtin }` |
| GET | `/api/style-memory?topicId=` | `{ topicId, profile, editCount }`，`profile` 为空串表示尚未生成 |
| POST | `/api/style-memory/refresh` | `{ topicId }` → 重新分析并落库；样本不足时 400 + 说明还差几条 |

### 3.3 稿件与阶段

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/projects` | — | `{ projects: ProjectRow[] }` |
| POST | `/api/projects` | `{ title?, topicId }` | `{ project }` |
| POST | `/api/projects/import` | `{ title?, content, topicId }` | `{ project, title, htmlTags, converted, hanCount }` |
| GET | `/api/projects/[id]` | — | `{ project, stages, messages }` |
| PATCH | `/api/projects/[id]` | `{ title?, topicId?, stage? }` | `{ project }` |
| DELETE | `/api/projects/[id]` | — | `{ ok: true }` |
| POST | `/api/projects/[id]/stages/[stage]` | `{ input, skills?, lengthTarget? }` | `{ content, stageResult, quality?, timings?, revisionNote? }`（跑一次阶段） |
| POST | `/api/projects/[id]/stages/[stage]/confirm` | `{ content }` | `{ project, stageResult }`（签字并推进工序） |
| POST | `/api/projects/[id]/stages/[stage]/edit` | `{ before, after }` | `{ edit }`（记一次人工修改） |

阶段路由的 `stage` 取值必须是 `brief\|angle\|outline\|article`，否则 400。

阶段路由的三个可选参数：

| 参数 | 说明 |
| --- | --- |
| `skills` | 本次启用的技能包 id 数组。只在 `brief` 与 `article` 两个阶段生效：材料解读管的是「怎么总结」，正文管的是「怎么写」。中间两个阶段忽略它。 |
| `lengthTarget` | 界面上手填的字数目标（`"1000"`、`"800-1200"`、`"1200 字左右"` 都认）。优先级最高，压过输入里谈篇幅的那句话、大纲的总账与默认篇幅。 |
| `input` | 本次的用户输入。**里面的字数默认不算篇幅目标**：只有同一句话里同时出现「谈篇幅的词」和字数才算（「写 1000 字左右」算，「素材大概 2500 字」不算）。 |

**输入可以为空**：第一次生成不用填——稿台拿上一阶段的材料自己往下走（这是「大纲自动出一份给我看」的实现方式）。
追问必须填：追问是给模型的指令，没内容就没东西可说。服务端按阶段给一句默认指令（"请基于上面的材料解读，给出几个能写成稿子的方向"），
避免模型收到空消息后反问或瞎编。首道工序（材料解读）例外：没有材料就没有可解读的东西。

### 3.3.3 导入已有文章

`POST /api/projects/import` 把一篇现成的文章直接放进正文阶段，**跳过前三道工序**。

| 环节 | 规则 |
| --- | --- |
| 输入 | Markdown 或 HTML 都收；只认像 HTML 才洗一遍（纯 Markdown 过转换器会被误伤） |
| HTML → Markdown | `htmlToMarkdown`：保留标题、加粗、链接、图片、引用、列表；丢掉颜色字号等样式。脚本与样式整块删除 |
| 标题 | 用户填的优先；否则取第一个一级标题；再否则取第一行非空文字 |
| 落库 | 正文阶段直接落成 `confirmed`（文章就是定稿，没有再确认一遍的道理），稿件当前阶段直接是 `article` |
| 识别 | 稿件页靠「正文已签字 + 前面三道都空」认出这是导入的文章，工序带上前三道显示「已跳过」，并给一条说明 |

**外链图**：公众号不接受外链图片，所以推草稿前会把正文里的外链图
先下载到本机素材库、再换成微信自己的地址（`cdnizeLocalImages`）。
下载前检查目标 IP：内网、回环、链路本地一律拒绝——
稿台是本地软件，但用户会往里贴任意网址，不挡就成了「用软件读内网」的工具。

字数目标的完整优先级：`lengthTarget` 手填 > 输入里谈篇幅的那句 > 大纲的总字数估算 >
选题的适合篇幅 > 材料解读里定的篇幅 > 默认 700–1200 字。`quality.target.source`
把来源如实标出来（`input` / `outline` / `angle` / `brief` / `default`）。

**默认篇幅同时是硬边界**：模型自己写的数（大纲的总账、选题的适合篇幅、材料里定的篇幅）
只能在 700–1200 之间收窄，推不出去——真模型实测（2026-10-23）交过 1520–1920 字的大纲总账。
收窄时 `target.raw` 保留原来的原话（形如 `3520–4000 字（超出默认篇幅 700–1200 字，按默认篇幅写）`），
来源标成 `default`。用户自己手填或明确在输入里说出的字数不受这个限制。

**字数目标只管到选题和大纲两道工序。** 正文阶段的提示词里一个字数都不给：

- `renderLengthInstruction(target, stage)` 的 `stage` 类型里**没有 `article`**——
  不是「正文分支返回空」，是根本传不进来；
- 大纲末尾那行「总字数估算」和各段的「篇幅：xxx 字」不会流进正文上下文
  （`stripLengthLines()` 在整份带上原文时去掉它们）；
- 目标本身还在，只用于两件事：算输出额度（`generationBudget()`）、
  以及成稿体检报告里显示「距目标多少字」（只报不改）。

### 3.3.1 正文阶段的两条特殊规则

| 规则 | 说明 |
| --- | --- |
| **不给任何工具** | 正文阶段走纯 `chat`，不挂 `check_prose`，也不让模型读技能包。技能包的「怎么写」那一节由服务端注入提示词。「写完自查再改」是程序型指令，会把思考额度吃光、正文一个字没有。 |
| **上下文只拿骨架** | 只带大纲的结构化部分（推进 / 目的 / ≤40 字的内容 / 素材 / 形式）、大纲开头的三个头、以及材料解读里的硬事实。选题阶段的论证过程不带。 |

### 3.4 素材与配图

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/files` | 列出本地图片 |
| POST | `/api/files` | multipart `file` 上传一张图进素材库（细节见 3.7） |
| DELETE | `/api/files` | `{ path }` 删除一张 |
| GET | `/api/files/img/[...path]` | 返回图片二进制 |
| POST | `/api/image-render` | 程序化渲染一张装饰卡片 PNG |
| POST | `/api/image-prompts` | 为文章生成配图的视觉提示词（拿去**外部**生图工具用） |

### 3.5 微信

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wechat/config` | `{ configured, appIdMasked, coverConfigured }` |
| POST | `/api/wechat/config` | `{ appId, appSecret }` 写入 .env |
| POST | `/api/wechat/test` | `{ appId?, appSecret? }` → 测通道通不通。**只测不存** |
| GET | `/api/wechat/theme?projectId=` | `{ theme, templateId }` 稿件当前用的配色/模板 |
| POST | `/api/wechat/theme` | `{ projectId, theme? , templateId? }` 记下稿件用哪套 |
| GET | `/api/wechat/preview?projectId=&templateId=` | `{ html, text, title, theme, templateId, templateName }` 公众号预览 |
| POST | `/api/wechat/draft` | `{ projectId, title?, digest?, theme?, templateId? }` → 渲染并推草稿箱 |
| POST | `/api/wechat/upload-local-images` | `{ projectId }` → 上传正文引用的本地图片 |
| GET | `/api/wechat/statistics` | 已发布文章的阅读/在看/分享数据 |
| POST | `/api/wechat/sync` | 拉取已发布文章列表 |

**先测后发（硬约束）**：

| 规则 | 说明 |
| --- | --- |
| **测通 = 拿到 access_token** | 这一步同时验三件事：凭据对不对、本机 IP 在不在白名单、账号有没有这个接口的权限。没有第三种状态 |
| **测试只测不存** | 临时填的 AppID/AppSecret 不会被写进 .env。保存是「保存配置」按钮的活 |
| **测不通不许推** | `POST /api/wechat/draft` 在推之前自己再验一次（token 有两小时缓存，几乎不额外发请求）。不通过直接 400 + 人话原因。**不是界面上的禁用按钮**——直接打接口一样推不出去 |
| **错误码要翻成人话** | 40164 / 40125 / 40013 / 48001 / 45009 都有对应的原因与下一步。未知码把微信原话带出去，不装作认识 |
| **40164 要报出本机 IP** | 微信的报错里带着它看到的出口 IP，抠出来直接告诉用户「把这个 IP 加进白名单」，省掉用户自己查公网 IP 的一步，也不用把 IP 发给第三方查询服务 |
| **网络层失败 ≠ 业务错误** | 取 token 超时 / 连不上服务器，不报「未知错误」，报「连不上微信服务器」并给出该检查什么 |

**已知的、绕不过去的坎**：微信要求调用方的公网 IP 在白名单里，白名单只认最多 20 个**精确 IPv4**
（不支持域名或 IP 段），改完 5–10 分钟生效。家宽 IP 动态，填了也会失效。
稿台能做的只是把卡点说清楚；真要过这一关得有固定出口 IP。


**稿件用哪套模板的优先级**（`resolveTemplateForProject`）：
请求里的 `templateId` > 请求里的 `theme` > 已记下的 `template_id` > 已记下的 `theme` > 默认。

**推草稿是幂等的**：稿台记着这份稿子的内容指纹（正文 + 模板 + 标题 + 摘要）。
内容没变就什么都不推（回原来那份草稿的 id），变了才更新那一份——
不会推两次就在草稿箱里躺两份。响应里回 `action`：`created` / `unchanged` / `updated`。

### 3.6 排版模板

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/layout-templates` | — | `{ templates }` 内置纯配色 + 随包主题 + 用户自己的 |
| POST | `/api/layout-templates` | `{ id?, name, description?, source?, template }` | `{ template }`；带 id 是改，不带是新建 |
| DELETE | `/api/layout-templates?id=` | — | `{ ok: true }`；内置删不掉，返回 404 |
| POST | `/api/layout-packs` | `{ text }` 样式包 JSON 原文 | `{ template, warnings }`——**只解析不落库** |

`source` 取值：`builtin`（内置，只读）/ `imported`（从样式包导入）/ `custom`（自己改的）。

### 3.6.1 模板库页与 WeDraft 转换

**页面职责**：

- `/templates`（模板页）是**同一个页面的两种模式**，顶部两个 Tab：
  - 「模板库」= 浏览 + 选择：平铺卡片 + 手机预览，点击卡片只更新手机预览、
    不立即应用；「使用这套」带 `?project=<id>` 时调 `POST /api/wechat/theme` 把该稿件的
    `template_id` 改到所选模板，然后跳回 `/projects/<id>`。
  - 「模板管理」= 导入样式包（`POST /api/layout-packs`）、取舍部件、编辑色值、
    存为我的（`POST /api/layout-templates`）、删除（`DELETE /api/layout-templates`）。
- `/layout` 重定向到 `/templates?tab=manage`，仅作旧链接兼容。
- 两种模式共用同一份模板清单；导航只有一个「模板库」入口，不再并列「排版」。

**接口复用**：模板库页**不新增接口**——清单读 `GET /api/layout-templates`；
示例稿按所选模板渲染走 `GET /api/wechat/preview`；应用走 `POST /api/wechat/theme`。

**WeDraft 转换（元素→CSS 到 部件→HTML）**：

- 生成物 `resources/layout-packs/wedraft-<id>.json`，schema 与本目录现有包一致
  （`name` / `description` / `source` / `vars` / `parts`）。
- 映射规则：`article` / `body` → `root`；`heading2` / `heading3` / `heading4` → `heading` / `heading3` /
  `heading4`；`paragraph` → `paragraph`；`strong` / `em` / `link` / `inlineCode` / `code` 同名；
  `quote` / `quoteMark` → `quote`（装饰字符第一版丢弃）；`list` / `listItem` 同名；
  `table` / `tableHead` / `tableCell` 同名；`image` / `imageCaption` → `image`（图注并入图片块）；
  `divider` 同名。
- 已丢弃（记录为已知限制）：`headingNumber` / `headingText`（章节序号层，稿台部件模型无此层）、
  `referenceTitle` / `referenceNumber` 等参考文献部件、`quoteMark` 的装饰字符、`imageCaption` 作为独立块。
- 色值收敛：`accent` ← `accentColor`，其余（`text` / `heading` / `muted` / `border` / `surface` /
  `codeBg` / `codeText`）从对应元素推导；HTML 里用 `{{var}}` 引用，不散落硬编码色值。
- 生成物必须能通过 `parseLayoutPack()` 且 0 warnings；转换脚本 `scripts/convert-wedraft-templates.mts`
  可重复运行，参考仓库路径由参数给（默认 `.tmp/refs/WeDraft`），不依赖 `.tmp/` 参与构建。

### 3.7 素材库与插图

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/files` | — | `[{ path, size, mtime, url }]` 素材库列表 |
| POST | `/api/files` | multipart `file` | `{ ok: true, image: { path, size, mtime, url } }`；超 10MB 或格式不对 400 |
| DELETE | `/api/files` | `{ path }` | `{ ok: true }` |

**稿台不生图。** 图从外面来（别的工具生图、截图、照片），流程是：

```
外部生图 → 上传进素材库 → 稿件页「插入图片」→ 正文里出现 ![配图](/api/files/img/…)
   → 推草稿时逐张换成微信自己的地址
```

| 规则 | 说明 |
| --- | --- |
| **图必须插进正文** | 公众号只认微信自己的地址，正文里的外链图会被过滤掉。图只躺在素材库里，复制正文过去仍然没有图 |
| **插的是正文阶段** | 配图是给成稿用的，不插到简报或大纲里。插完要点「保存修改」才落库 |
| **保留原文件名** | 外部生图工具给的名字就是线索（`2026-10-24_横版_公众号知乎_承受得起_2000x1116.jpg`）。Windows 非法字符换成下划线、目录部分去掉、重名加序号（`…-2.png`），绝不覆盖已有文件 |
| **地址按段百分号编码** | 文件名带中文时，地址是编码过的。推草稿时要把地址**解码**回文件名才找得到磁盘上的文件——不解码就永远找不到，图会丢 |
| **宽高都 ≤2000px** | 平台红线。稿台不替用户缩放；超限的图由用户自己压 |


### 3.8 安全

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/security/login-failures` | 最近失败登录记录 |

---

## 4. 目录与资源

```
src/lib/
  markdown.ts         Markdown → 公众号 HTML（渲染器走部件模板）
  html-util.ts        拼 HTML 的小工具：转义、行内样式、代码块正文
  wx-theme.ts         三套内置配色（13 个变量）
  layout-template.ts  排版模板：部件模型 + 部件目录 + 样式包清洗与解析
  layout-store.ts     排版模板存取 + 稿件用哪套模板的优先级
  files.ts            素材库：存图、读图、地址编码、文件名清洗
src/app/
  templates/          模板库页：平铺卡片 + 手机预览（浏览与选择）
  layout/             排版模板管理页：导入样式包 → 取舍 → 编辑 → 预览
  files/              素材库页：上传图片 → 复制引用 → 删除
resources/
  prompts/                 各阶段提示词（system/brief/angle/outline/article/style-profile/image-prompt）
  topics/<id>/             公开专题：meta.yaml + rules.md
  skills/                  写作技能卡
    gaotai-longform/       稿台自带的公众号长文写作方法（MIT）+ LICENSE/NOTICE
    gaotai-editorial/      成稿后的标题、开头、事实核查规则
    human-writing/         第三方通用中文写作技能（MIT）
  layout-packs/            随包分发的排版样式包（内置模板）+ LICENSE/SOURCE 溯源
docs/
  design/                  设计规则（如 template-gallery.md，供子代理按文实现与验收）
  architecture/decisions/  ADR 决策记录
<数据根>/                  可写
  .env                     密钥与登录配置
  data/gaotai.sqlite       数据库
  data/local/topics/<id>/  用户自建专题（覆盖同 id 的公开专题）
  images/                  本地生成配图
  data/agent-config.json   模型配置（密钥加密存储）
```

**环境变量契约**（Electron 注入后端子进程）：

| 变量 | 含义 |
| --- | --- |
| `GAOTAI_RESOURCE_DIR` | 只读资源根目录（打包态 = `resources/app-resources`，内含 prompts/topics/skills） |
| `GAOTAI_DATA_DIR` | 可写数据根目录（打包态 = `userData`） |
| `GAOTAI_MODE` | `production` / `dev` |
| `GAOTAI_PORT` | 优先使用的后端端口 |

开发态两个根目录都退回 `process.cwd()`，因此开发与安装后的行为完全一致。

---

## 5. 模型接入

不使用任何 Agent 框架，直接对接 OpenAI 兼容端点：

```
POST {apiBaseUrl}/chat/completions
{ model, messages, temperature, max_tokens, stream: false }
```

配置来源：`src/lib/agent-config-store.ts`（密钥 AES-256-GCM 加密落盘，口令由 `.env` 的
`SESSION_SECRET` 派生）。系统提示由**阶段引擎**组装，模型配置里的 `systemPrompt` 作为用户
全局附加提示追加在各阶段 system 提示末尾。

---

## 6. 视觉

Neo-Brutalist：零模糊阴影（只用 `6px 6px 0` 硬边偏移）、3px 粗描边、几乎无圆角、高饱和平涂色块、
米白网格底。全部颜色走 `--gt-*` CSS 变量，因此深色模式只改变量。
类名规范见 `src/app/globals.css`（`gt-` 前缀）。
