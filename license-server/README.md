# 高台授权服务器 v1

本地优先写作工作台的授权服务器。零运行时依赖，仅用 Node 内置模块（`node:http`、`node:crypto`、`node:fs`），ESM，要求 Node >= 20。

唯一实现契约：`../docs/license-protocol.md`。

## 目录结构

```
license-server/
  package.json            零依赖，type=module
  server.mjs              入口：读环境变量 → createApp → listen → 优雅退出
  lib/config.mjs          环境变量解析 + 默认值 + 启动自检
  lib/store.mjs           JSON 存储：原子写、串行队列、激活码 CRUD、绑定、审计
  lib/token.mjs           Ed25519 签发/验签、gt1 token 编解码、HKDF 派生、AES-256-GCM
  lib/http.mjs            JSON body 解析、响应信封、CORS、限流器
  lib/assets.mjs          读 assets/packs/*.json + manifest，按 token 派生密钥加密
  lib/redeem-page.mjs     /redeem 自包含 HTML 表单页
  routes/                 activate / refresh / status / assets / redeem
  scripts/keygen.mjs      生成 Ed25519 密钥对
  scripts/license-cli.mjs 管理 CLI：issue / list / revoke / unrevoke / unbind / show / stats
  scripts/bundle-assets.mjs  打包 ../resources/{skills,prompts,topics,layout-packs}
  test/                   node --test 集成测试
  keys/                   运行期生成，不入 git
  data/                   运行期存储，不入 git
  assets/packs/           打包产物，不入 git
```

## 快速开始

### 1. 生成密钥对

```bash
node scripts/keygen.mjs
```

- 私钥写入 `keys/ed25519-private.pem`（权限 0600，不入 git）
- 公钥 PEM 打印到终端，供客户端内嵌
- 已存在私钥时拒绝覆盖，避免误删在用的密钥

### 2. 打包资产

```bash
node scripts/bundle-assets.mjs
```

把 `../resources/{skills,prompts,topics,layout-packs}` 打成 `assets/packs/<name>.json`（明文包）和 `assets/packs/manifest.json`。每个包的 `sha256` 是明文字节级摘要，客户端解密后据此校验。

### 3. 发码

```bash
# 通过 CLI
node scripts/license-cli.mjs issue --contact <微信号/手机号> [--channel direct] [--max-devices 1]

# 或通过网页
node server.mjs
# 浏览器打开 http://127.0.0.1:8787/redeem
```

### 4. 启动服务

```bash
node server.mjs
# 或指定端口
PORT=9000 node server.mjs
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LICENSE_DATA_DIR` | `./data` | 数据目录（license.json、audit.jsonl） |
| `LICENSE_KEY_DIR` | `./keys` | 密钥目录 |
| `LICENSE_ASSETS_DIR` | `./assets/packs` | 资产包目录 |
| `TRUST_PROXY` | 未设置 | 设为 `1` 时信任 `X-Forwarded-For` 第一跳（nginx 反代后开启） |
| `TOKEN_TTL_DAYS` | `30` | token 有效期天数 |
| `RATE_FAILS` | `5` | 限流阈值：窗口内失败次数 |
| `RATE_WINDOW_MS` | `300000` | 限流窗口（5 分钟） |
| `REDEEM_PER_HOUR` | `20` | 领码：同 IP 每小时上限 |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/activate` | 激活注册码，绑定机器，签发 token |
| POST | `/v1/refresh` | 刷新 token（需已绑定机器） |
| POST | `/v1/status` | 查询激活状态、吊销、过期、最后在线 |
| GET | `/v1/assets/manifest` | 资产清单（需 Bearer token） |
| GET | `/v1/assets/:name?version=` | 加密资产（需 Bearer token，version 必须匹配 manifest） |
| POST | `/v1/redeem` | 领码（同 contact 幂等） |
| GET | `/redeem` | 领码 HTML 表单页 |

响应信封：`{ ok: true, data: {...} }` 或 `{ ok: false, error: { code, message } }`。

## 部署

### systemd

```ini
# /etc/systemd/system/gaotai-license.service
[Unit]
Description=Gaotai License Server
After=network.target

[Service]
Type=simple
User=gaotai
WorkingDirectory=/opt/gaotai/license-server
EnvironmentFile=/opt/gaotai/license-server/.env
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### nginx 反代

```nginx
server {
    listen 443 ssl http2;
    server_name license.maning789link.top;

    ssl_certificate     /etc/ssl/license.crt;
    ssl_certificate_key /etc/ssl/license.key;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

反代后必须设置 `TRUST_PROXY=1`，否则限流会把所有请求当成来自 127.0.0.1。

### 备份

- `keys/ed25519-private.pem`：**最重要**，丢失则所有已签发 token 无法刷新。离线备份，不要进 git。
- `data/license.json`：激活码与绑定记录。定期备份即可。
- `data/audit.jsonl`：审计日志，按需归档。

### 发码流程

1. 运维通过 CLI 或网页发码
2. 用户拿到 `GT-XXXX-XXXX-XXXX-XXXX` 注册码
3. 客户端激活页输入注册码，调用 `/v1/activate`
4. 服务器绑定机器码、签发 30 天有效 token
5. 客户端缓存 token，剩余不足 7 天时自动 `/v1/refresh`

## 测试

```bash
node --test
```

集成测试起 `createApp` + `http.listen(0)`，用 `fetch` 打真实 HTTP，覆盖：激活验签、同机幂等、跨机 device_limit、吊销 refresh、未绑定 machine_mismatch、6 次失败限流、资产加密解密 sha256 一致、过期/伪造 token 401、审计日志不含完整 contact、领码幂等与规范化。

## 安全要点

- 私钥 0600，不入 git、不进日志、不落审计
- 审计日志只记 code 前 4 位、IP、错误码、时间，绝不记完整 contact 或 token
- 资产密钥从 token 派生（HKDF-SHA256），不落盘、不进日志
- token 过期即取不到新资产（已缓存的明文包仍可离线用）
- 限流只计失败，成功不计数
- 启动自检：私钥缺失/不可读、data 不可写时拒绝启动

## 上线前检查（license.maning789link.top）

按顺序做完这七项，客户端才能真的激活成功。

1. **域名解析**：`license.maning789link.top` 的 A 记录指向 `101.43.65.216`。
2. **备案**：服务器在国内（腾讯云），80/443 对外提供 HTTP 服务需要 ICP 备案；未备案会被拦截，
   表现是「浏览器能 ping 通但打不开」。备案未完成前可先用非标端口 + 直连 IP 做内部联调。
3. **证书**：签发后放到 nginx，确认 `https://license.maning789link.top/redeem` 能打开且证书链完整
   （`curl -I` 不报 `SSL certificate problem`）。
4. **生成密钥**（只做一次，做之前先想好备份）：
   ```bash
   node scripts/keygen.mjs          # 打印公钥 PEM
   chmod 600 keys/ed25519-private.pem
   ```
   打印出的公钥必须与 `src/lib/license/public-key.ts` 里的常量**逐字节一致**；不一致就说明换了密钥，
   旧的注册码与 token 全部失效，客户端也要重新打包。
5. **环境变量**：`TRUST_PROXY=1`（nginx 反代后必须）、`HOST=127.0.0.1`（只让 nginx 访问）、
   `LICENSE_DATA_DIR=/opt/gaotai/data`、`LICENSE_KEY_DIR=/opt/gaotai/keys`（**不要放在代码目录里**，
   重新部署会覆盖）。写进 systemd 的 `EnvironmentFile`，不要写进 shell history。
6. **自检**：
   ```bash
   curl -s https://license.maning789link.top/redeem -o /dev/null -w '%{http_code}\n'   # 200
   curl -s https://license.maning789link.top/v1/assets/manifest                          # 401
   curl -s -X POST https://license.maning789link.top/v1/activate \
        -H 'Content-Type: application/json' -d '{}'                            # 400 bad_request
   ```
7. **备份**：`keys/ed25519-private.pem` 离线存两份（丢了所有用户都要重新激活）；
   `data/license.json` 每日备份。

### 上线后第一件事

自己先领一个码、在自己机器上激活一次，确认「发码 → 激活 → 资产下发 → 写作可用」整条链路通，
再去发注册码给别人。发码命令：

```bash
node scripts/license-cli.mjs issue --contact <你的微信号> --channel direct
```
