// 标书（老马标书贤内助）产品发码桥：issue 回调走这里而不是本地 store。
//
// 背景：标书客户端激活时校验的是**标书服务器自己的 licenses 表**
// （/opt/bidmaster，Ed25519 体系），与稿台的码库互不相通。因此微信侧
// 发出的标书码必须通过标书服务器的管理 API 在那边真实落一条记录，
// 否则用户拿到码也激活不了。
//
// 幂等约定：同一 openid 永远返回同一个码（映射落 <dataDir>/bidmaster-issued.json，
// 与稿台 store 的 contact 幂等语义对齐，但独立存放——两种码的生命周期不同）。
//
// 管理凭据来自环境变量（写在服务器 .env，绝不入库）：
//   BIDMASTER_API_URL    默认 http://127.0.0.1:8093（同机部署）
//   BIDMASTER_ADMIN_USER 管理员用户名（服务号发码专用 bot 账号）
//   BIDMASTER_ADMIN_PASS 管理员密码
//
// fetch 可注入以便单测。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ISSUE_TIMEOUT_MS = 15000;

function readIssuedMap(dataDir) {
  const p = join(dataDir, 'bidmaster-issued.json');
  if (!existsSync(p)) return {};
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function writeIssuedMap(dataDir, map) {
  const p = join(dataDir, 'bidmaster-issued.json');
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  writeFileSync(p, JSON.stringify(map, null, 2), 'utf8');
}

async function login(fetchImpl, baseUrl, user, pass) {
  const res = await fetchImpl(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
    signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`bidmaster login failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.token) throw new Error('bidmaster login failed: no token');
  return data.token;
}

async function createLicense(fetchImpl, baseUrl, token, { customer, validDays }) {
  const res = await fetchImpl(`${baseUrl}/api/admin/licenses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ customer, valid_days: validDays }),
    signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`bidmaster create license failed: HTTP ${res.status} ${t.slice(0, 120)}`);
  }
  const data = await res.json();
  const code = (data && data.license && data.license.code) || '';
  if (!code) throw new Error('bidmaster create license failed: no code in response');
  return code;
}

export function createBidmasterIssuer({ dataDir, env = {}, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const baseUrl = (env.BIDMASTER_API_URL || 'http://127.0.0.1:8093').replace(/\/$/, '');
  const adminUser = env.BIDMASTER_ADMIN_USER || '';
  const adminPass = env.BIDMASTER_ADMIN_PASS || '';
  let cachedToken = null;

  const configured = () => Boolean(adminUser && adminPass);

  // 同一 openid 只创建一次；映射本地持久化。失败抛错，由调用方降级提示。
  async function issueForOpenid(openid, product) {
    if (!openid) return null;
    if (!configured()) throw new Error('bidmaster issuer not configured (BIDMASTER_ADMIN_USER/PASS)');

    const map = readIssuedMap(dataDir);
    const prev = map[openid];
    if (prev && prev.code) return prev.code;

    const validDays = Number((product && product.validityDays) || 15) || 15;
    // 登录/建码整体重试一次：任何一步 401/403（token 失效或瞬时拒绝）→ 清 token 重登再试。
    let code = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2 && !code; attempt++) {
      try {
        if (!cachedToken) {
          cachedToken = await login(fetchImpl, baseUrl, adminUser, adminPass);
        }
        code = await createLicense(fetchImpl, baseUrl, cachedToken, {
          customer: `wechat-oa:${openid}`,
          validDays,
        });
      } catch (err) {
        lastErr = err;
        // 非 401/403（如 5xx）直接抛；401/403 首次尝试清 token 重登重试，第二次仍失败则抛。
        if (!/HTTP 40[13]/.test(String(err)) || attempt === 2) throw err;
        cachedToken = null;
      }
    }
    if (!code) throw lastErr || new Error('bidmaster create license failed: exhausted retries');

    map[openid] = { code, issuedAt: now(), product: (product && product.key) || 'bidmaster' };
    writeIssuedMap(dataDir, map);
    return code;
  }

  return { issueForOpenid, configured };
}
