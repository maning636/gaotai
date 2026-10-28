// 网页后台的口令与会话认证。
//
// 为什么独立成模块：后台只暴露给运维（手机发码），安全面比 /redeem 高得多，
// 必须把「口令校验、会话签发/验签、失败限流」收拢到一处，路由层只做编排。
//
// 安全约定：
//  - 口令用 scrypt + timingSafeEqual，不做明文比较，防时序侧信道；
//  - 口令为空时整个后台降级为 503（绝不允许「无口令可进」）；
//  - 会话令牌是无状态 HMAC-SHA256 签名（紧凑串 payload.sig），服务端不存会话表，
//    进程重启后旧令牌自然失效——密钥未配置时用启动随机密钥并告警；
//  - 失败限流与现有 redeem limiter 同风格：进程内 Map、滑动窗口、过期清理。

import { scryptSync, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

// 口令校验：scrypt 输出 32 字节。
const KEY_LEN = 32;
// 会话有效期：12 小时，运维手机发码够用，过期需重新登录。
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// 失败限流：同 IP 5 分钟 5 次失败 → 锁 5 分钟（与协议 §4.1 同口径）。
const LOCK_WINDOW_MS = 5 * 60 * 1000;
const LOCK_MAX_FAILS = 5;
const LOCK_DURATION_MS = 5 * 60 * 1000;

export function createAdminAuth({ password, sessionSecret, now = Date.now }) {
  // 口令来自环境变量 ADMIN_PASSWORD，空值由路由层判定为「未配置」→ 503。
  // 这里只提供「是否配置」与「校验」两个能力，不替路由决定降级行为。
  const configured = typeof password === 'string' && password.length > 0;

  // 口令派生密钥：盐每次启动随机，只存内存、绝不落盘。跨进程校验结果不同
  // 也无妨——后台进程单实例，本进程内一致性已足够。
  const salt = randomBytes(16);
  let pwHash = null;
  if (configured) {
    pwHash = scryptSync(password, salt, KEY_LEN);
  }

  // 会话签名密钥：优先用环境变量 ADMIN_SESSION_SECRET；
  // 缺失时用启动随机密钥——旧会话在重启后全部失效，必须重新登录。
  // 这是刻意的安全取舍：与其用弱/缺省密钥，不如让「重启即全员重登」，
  // 代价只是运维多输一次口令。
  const hasSecret = typeof sessionSecret === 'string' && sessionSecret.length > 0;
  const secret = hasSecret ? sessionSecret : randomBytes(32).toString('hex');
  if (!hasSecret) {
    console.warn('[admin] 未配置 ADMIN_SESSION_SECRET，使用进程随机密钥（重启后需重新登录）');
  }

  function verifyPassword(plain) {
    if (!configured) return false;
    if (typeof plain !== 'string') return false;
    const candidate = scryptSync(plain, salt, KEY_LEN);
    return timingSafeEqual(candidate, pwHash);
  }

  // 签发紧凑会话令牌：base64url(payload) + '.' + base64url(hmac)
  // payload = { iat, exp }，无服务端状态，验签即可确认身份。
  function issueSession() {
    const iat = now();
    const exp = iat + SESSION_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ iat, exp })).toString('base64url');
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    return payload + '.' + sig;
  }

  // 验签并检查过期；任何畸形/伪造令牌返回 null（路由层据此当作未登录）。
  function verifySession(token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac('sha256', secret).update(payloadB64).digest('base64url');
    // 先比长度再 timingSafeEqual：长度不符直接短路，避免 Buffer.from 抛错
    if (sig.length !== expected.length) return null;
    let sigBuf, expBuf;
    try {
      sigBuf = Buffer.from(sig, 'base64url');
      expBuf = Buffer.from(expected, 'base64url');
    } catch {
      return null;
    }
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp < now()) return null;
    return payload;
  }

  // ---- 失败限流：进程内 Map，5 分钟 5 次失败 → 锁 5 分钟 ----
  // 与 http.mjs 的 createRateLimiter 同风格；区别在语义：这里是「锁窗口」，
  // 一旦达到阈值，在锁存续期间一律拒绝，直到锁过期才允许再次尝试。
  const lockMap = new Map(); // ip -> { count, lockedUntil, lastFailAt }

  // 记一次失败；返回 true 表示本次调用恰好触发了锁定。
  function recordFail(ip) {
    const nowMs = now();
    let entry = lockMap.get(ip);
    if (!entry) {
      lockMap.set(ip, { count: 1, lockedUntil: 0, lastFailAt: nowMs });
      return false;
    }
    // 锁已过期：重置后重新计
    if (entry.lockedUntil && entry.lockedUntil <= nowMs) {
      lockMap.set(ip, { count: 1, lockedUntil: 0, lastFailAt: nowMs });
      return false;
    }
    // 未锁但距上次失败已超窗口：滑动窗口重置
    if (!entry.lockedUntil && entry.lastFailAt && entry.lastFailAt <= nowMs - LOCK_WINDOW_MS) {
      lockMap.set(ip, { count: 1, lockedUntil: 0, lastFailAt: nowMs });
      return false;
    }
    entry.count += 1;
    entry.lastFailAt = nowMs;
    if (entry.count >= LOCK_MAX_FAILS) {
      entry.lockedUntil = nowMs + LOCK_DURATION_MS;
      return true;
    }
    return false;
  }

  // 是否处于锁定期（含锁过期后的清理）
  function isLocked(ip) {
    const nowMs = now();
    const entry = lockMap.get(ip);
    if (!entry) return false;
    if (entry.lockedUntil && entry.lockedUntil > nowMs) return true;
    if (entry.lockedUntil && entry.lockedUntil <= nowMs) {
      lockMap.delete(ip);
      return false;
    }
    if (entry.lastFailAt && entry.lastFailAt <= nowMs - LOCK_WINDOW_MS) {
      lockMap.delete(ip);
    }
    return false;
  }

  // 周期清理，避免长期不活跃 IP 占内存
  function sweep() {
    const nowMs = now();
    for (const [ip, entry] of lockMap) {
      if (entry.lockedUntil && entry.lockedUntil <= nowMs) {
        lockMap.delete(ip);
        continue;
      }
      if (!entry.lockedUntil && entry.lastFailAt && entry.lastFailAt <= nowMs - LOCK_WINDOW_MS) {
        lockMap.delete(ip);
      }
    }
  }

  function reset(ip) {
    if (ip) lockMap.delete(ip);
    else lockMap.clear();
  }

  return {
    configured,
    verifyPassword,
    issueSession,
    verifySession,
    recordFail,
    isLocked,
    sweep,
    reset,
    maxFails: LOCK_MAX_FAILS,
    _lockMap: lockMap,
  };
}
