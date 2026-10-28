// 协议 §1：请求体上限 64KB，防止恶意大包撑内存
const MAX_BODY = 64 * 1024;

// 协议 §4：统一响应信封
export function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

export function ok(res, data, status = 200) {
  json(res, status, { ok: true, data });
}

export function fail(res, code, message, status = 400) {
  json(res, status, { ok: false, error: { code, message } });
}

// 协议里的错误码到 HTTP 状态码映射，集中维护避免散落
const STATUS_BY_CODE = {
  bad_request: 400,
  bad_contact: 400,
  invalid_code: 404,
  code_revoked: 403,
  device_limit: 403,
  machine_mismatch: 403,
  rate_limited: 429,
  unauthorized: 401,
  not_found: 404,
};

export function failByCode(res, code, message) {
  const status = STATUS_BY_CODE[code] || 400;
  fail(res, code, message, status);
}

// 读取并解析 JSON body，超过 64KB 或解析失败返回 null
export function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // 超限直接截断，不再累积，避免继续吃内存
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) {
        resolve(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// CORS 只给 /redeem 页用；API 接口由客户端直连，不需要跨域
export function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// 从请求里取客户端 IP
// 只在配置了 TRUST_PROXY=1 时信任 X-Forwarded-For 第一跳，避免直连时伪造
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      // 取第一跳，trim 防止空白
      return xff.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || '';
}

// 限流器：进程内 Map，滑动窗口内累计失败次数
// 协议 §4.1：同 IP 5 分钟 5 次失败 → rate_limited
// 这里只记录失败，成功不计数；测试可注入独立实例避免互相污染
export function createRateLimiter({ maxFails, windowMs, now = Date.now }) {
  const map = new Map(); // ip -> { fails: [ts,...] }

  function prune(ip) {
    const entry = map.get(ip);
    if (!entry) return;
    const cutoff = now() - windowMs;
    entry.fails = entry.fails.filter((ts) => ts > cutoff);
    if (entry.fails.length === 0) {
      map.delete(ip);
    }
  }

  // 周期性全量清理，避免长期空跑的 IP 占内存
  function sweep() {
    const cutoff = now() - windowMs;
    for (const [ip, entry] of map) {
      entry.fails = entry.fails.filter((ts) => ts > cutoff);
      if (entry.fails.length === 0) map.delete(ip);
    }
  }

  return {
    // 记一次失败
    recordFail(ip) {
      prune(ip);
      let entry = map.get(ip);
      if (!entry) {
        entry = { fails: [] };
        map.set(ip, entry);
      }
      // prune 后再 push，避免先 push 再被 prune 清空导致状态丢失
      entry.fails.push(now());
    },
    // 返回是否已被限流
    isLimited(ip) {
      prune(ip);
      const entry = map.get(ip);
      if (!entry) return false;
      return entry.fails.length >= maxFails;
    },
    // 剩余失败配额，便于调试
    remaining(ip) {
      prune(ip);
      const entry = map.get(ip);
      if (!entry) return maxFails;
      return Math.max(0, maxFails - entry.fails.length);
    },
    reset(ip) {
      if (ip) map.delete(ip);
      else map.clear();
    },
    sweep,
    _map: map,
  };
}

// 领码限流：同一 IP 每小时 N 次（不分成功失败，因为领码页是公开入口）
export function createRedeemLimiter({ perHour, now = Date.now }) {
  const WINDOW = 60 * 60 * 1000;
  const map = new Map(); // ip -> [ts,...]

  function prune(ip) {
    const arr = map.get(ip);
    if (!arr) return;
    const cutoff = now() - WINDOW;
    const filtered = arr.filter((ts) => ts > cutoff);
    if (filtered.length === 0) map.delete(ip);
    else map.set(ip, filtered);
  }

  return {
    check(ip) {
      prune(ip);
      const arr = map.get(ip) || [];
      if (arr.length >= perHour) return false;
      arr.push(now());
      map.set(ip, arr);
      return true;
    },
    reset(ip) {
      if (ip) map.delete(ip);
      else map.clear();
    },
    _map: map,
  };
}

// 机器码格式校验：协议 §2，sha256 结果是 64 位小写 hex
export function isValidMachine(m) {
  return typeof m === 'string' && /^[0-9a-f]{64}$/.test(m);
}

// 取 Authorization: Bearer <token>
export function bearerToken(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
