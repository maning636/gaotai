# 授权协议 v1（客户端 ↔ 授权服务器）

本文件是**唯一契约**。客户端与授权服务器分头实现，任何一方改动字段都必须先改这里。

## 0. 名词

| 词 | 含义 |
| --- | --- |
| 注册码（code） | 发给用户的字符串，形如 `GT-7F3K-9QW2-M4XB-8HZP`。可公开传递，不当作密码 |
| 机器码（machine） | 本机指纹，`sha256(salt + tpm/uuid + 磁盘序列号)` 的十六进制，见 §2 |
| 令牌（token） | 服务器用 Ed25519 私钥签发的凭证，格式见 §3 |
| 资产包（asset） | 技能包 / 提示词 / 专题 / 排版包，加密下发，见 §5 |

## 1. 地址与传输

- 客户端读取环境变量 `GAOTAI_LICENSE_SERVER`，例如 `https://license.example.com`，**不带尾斜杠**。
- 生产必须 HTTPS。开发可用 `http://127.0.0.1:8787`。
- 所有请求与响应都是 `application/json; charset=utf-8`。
- 客户端上报 `User-Agent: gaotai/<version>`，并带 `X-Gaotai-App: <version>`。

服务端路由前缀统一 `/v1`。

## 2. 机器码

客户端计算，服务端只做字符串校验（`^[0-9a-f]{64}$`）：

```
material = "gaotai-v1|" + hardId + "|" + diskSerial
machine  = sha256(material)
```

- `hardId`：优先 `Win32_ComputerSystemProduct.UUID`；失败退 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`；再失败退 `os.hostname()`。
- `diskSerial`：优先第一块物理磁盘序列号；取不到用空串。
- 结果缓存到 `<dataDir>/.license/machine`，避免每次启动跑 PowerShell。
- 允许用户在激活页手动复制机器码。

## 3. 令牌

格式：

```
gt1.<base64url(payloadJSON)>.<base64url(signature)>
```

- `signature = Ed25519_sign(privateKey, "gt1." + base64url(payloadJSON))`
- 客户端用内置公钥验签，**必须**校验 `machine` 与本机一致、`expiresAt > now`。

`payloadJSON` 字段（全部必填）：

```json
{
  "v": 1,
  "code": "GT-7F3K-9QW2-M4XB-8HZP",
  "machine": "<64位hex>",
  "issuedAt": 1750000000000,
  "expiresAt": 1752592000000,
  "features": ["core", "skills", "prompts", "topics", "layout-packs", "illustration"],
  "plan": "free"
}
```

- 有效期 30 天；客户端在**剩余不足 7 天**或启动时刷新。
- `features` 决定客户端灰化哪些功能；`core` 恒有。

## 4. 接口

统一响应信封：

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "invalid_code", "message": "注册码不存在" } }
```

### 4.1 POST /v1/activate

请求：
```json
{ "code": "GT-...", "machine": "<hex64>", "appVersion": "0.2.0", "os": "win32 10.0.19045" }
```

- 成功：`data = { token, expiresAt, features, plan, code }`
- 失败：`invalid_code`(404) / `code_revoked`(403) / `device_limit`(403) / `rate_limited`(429) / `bad_request`(400)
- 绑定规则：同一 code 首次激活写入 (code, machine)；同 code 再激活同一 machine 直接放行；不同 machine 且已达 `maxDevices`（默认 1）→ `device_limit`。
- 限流：同 IP 5 分钟内 5 次失败 → `rate_limited`。

### 4.2 POST /v1/refresh

请求：`{ "code": "...", "machine": "<hex64>", "appVersion": "0.2.0" }`

- 未绑定该 machine → `machine_mismatch`(403)
- code 被吊销 → `code_revoked`(403)
- 成功：同 §4.1 的 `data`
- 每次刷新更新 `lastSeenAt`，这是「服务停了就锁」的依据。

### 4.3 POST /v1/status

请求：`{ "code": "...", "machine": "<hex64>" }`
成功：`data = { activated: boolean, revoked: boolean, expiresAt: number|null, lastSeenAt: number|null, plan: "free" }`

### 4.4 GET /v1/assets/manifest

请求头：`Authorization: Bearer <token>`

```json
{ "ok": true, "data": { "version": "2026-10-28", "assets": [
  { "name": "skills", "version": "2026-10-28", "bytes": 215040,
    "sha256": "<明文包 sha256>", "url": "/v1/assets/skills?version=2026-10-28" }
] } }
```

### 4.5 GET /v1/assets/{name}?version=...

请求头：`Authorization: Bearer <token>`

```json
{ "ok": true, "data": {
  "name": "skills", "version": "2026-10-28",
  "plainSha256": "<hex>",
  "iv": "<base64 12字节>", "tag": "<base64 16字节>", "data": "<base64 密文>"
} }
```

加密：`AES-256-GCM`，密钥按 §5 从 token 派生。解密后的明文是：

```json
{ "version": "2026-10-28", "files": { "skills/xxx/SKILL.md": "<base64 内容>", "layout-packs/a.json": "<base64 内容>" } }
```

用 JSON 而不是 tar/zip，是为了服务端和客户端都不引第三方解包库；客户端解包前先校验 `plainSha256`。

## 5. 资产密钥派生

```
ikm  = utf8(token 字符串)
salt = utf8("gaotai-asset-v1")
info = utf8(name + ":" + version)
key  = HKDF-SHA256(ikm, salt, info, 32 字节)
```

- 服务端与客户端各自计算，密钥不落盘、不进日志。
- token 过期即取不到新资产；已缓存的明文包仍可用（离线友好），但**不提供**离线包下载接口。

## 6. 领码（网页/服务号入口）

### 6.1 POST /v1/redeem

```json
{ "contact": "微信号或手机号", "channel": "wechat-mp|wechat-oa|direct", "note": "" }
```

- 成功：`data = { code, contact, createdAt }`（同 contact 重复提交返回原码，不重复发）
- 失败：`bad_contact`(400) / `rate_limited`(429)

### 6.2 GET /redeem

返回一个自包含 HTML 表单页（无外部 JS/CSS），提交到 `/v1/redeem`，成功后显示注册码与「复制」。

## 7. 客户端行为

- 缓存文件 `<dataDir>/.license/token.json`：`{ token, expiresAt, machine, code, features, plan }`。
- 启动顺序：读缓存 → 验签（公钥 + machine + 有效期）→ 剩余 <7 天则刷新（失败不阻塞启动，进入 7 天宽限期）→ 无有效 token 则视为未激活。
- 未激活时：`/api/*` 除白名单（`/api/license/*`、`/api/auth/*`、`/api/files/*`、`/api/health`、`/api/security/*`）外一律 `403 { "error": "not_activated", "code": "not_activated" }`。
- 开发与测试：`GAOTAI_LICENSE_BYPASS=1` 时门禁放行（仅开发/测试用，打包脚本会剥离该变量）。
- 服务端地址未配置时，激活页显示「未配置授权服务器」，不静默放行。

## 8. 服务端要点

- 私钥 `license-server/keys/ed25519-private.pem`（0600，**不入库、不进 git**），公钥随客户端打包。
- 数据存储 `license-server/data/license.json`（原子写：写临时文件再 rename）。
- 管理员 CLI：发码、列出、吊销、解绑、查看在线（`lastSeenAt`）。
- 所有失败路径都要写审计日志（时间、IP、code 前 4 位、错误码），不记录完整 contact。
