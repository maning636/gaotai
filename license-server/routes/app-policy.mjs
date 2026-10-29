// GET /v1/app/policy：客户端版本策略探测接口。
//
// 用途：Electron 客户端每次启动时调一次，拿到服务端下发的版本策略，
// 据此提示或强制更新。下载地址走夸克网盘外链（mode=link），未来可切直链（mode=direct）。
//
// 安全要点：
//  - 不需要登录、不需要 token（客户端启动时可能还没授权）；
//  - 宽松限流：同 IP 每分钟 60 次（进程内 Map），超了 429。
//    这个接口每次启动都会被调，不能让它成为放大攻击点；
//  - blocked 判定对「version 缺失/非法」一律返回 false，绝不让探测请求把客户端锁死。
import { loadAppPolicy, compareVersions, isValidVersion } from '../lib/app-policy.mjs';
import { ok, failByCode, clientIp } from '../lib/http.mjs';

// 宽松限流器：同 IP 每分钟 N 次（滑动窗口，进程内 Map）。
// 与 http.mjs 里的 createRateLimiter 不同，这里是「计数」而非「记失败」——
// 版本策略接口本身就是高频合法入口，按总请求数限流。
export function createPolicyLimiter({ perMinute = 60, now = Date.now } = {}) {
  const WINDOW = 60 * 1000;
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
    // 放行则记录本次时间戳并返回 true；已达上限返回 false
    check(ip) {
      prune(ip);
      const arr = map.get(ip) || [];
      if (arr.length >= perMinute) return false;
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

export function createAppPolicyRoute({ config, limiter } = {}) {
  const policyLimiter = limiter || createPolicyLimiter();

  async function handle(ctx, req, res, url) {
    const ip = clientIp(req, config.trustProxy);

    // 限流前置：被限流的 IP 直接 429，不再读策略、不写盘。
    if (!policyLimiter.check(ip)) {
      failByCode(res, 'rate_limited', '请求过于频繁，请稍后再试');
      return;
    }

    // 每次从盘上读最新策略（后台改完立即生效，无需重启）。
    const { config: policy } = loadAppPolicy(config.dataDir);

    const version = (url.searchParams.get('version') || '').trim();
    // platform 查询参数可选（目前只支持 win32），本接口接受但不参与响应/判定；
    // 将来可按平台下发不同下载地址时再启用。未知值不报错，避免探测请求失败。

    // blocked 判定：version 合法且低于 minSupported → true；
    // version 缺失或非法 → false（不能让探测请求把客户端锁死）。
    // compareVersions 对脏数据返回 null，同样按不阻断处理。
    let blocked = false;
    if (isValidVersion(version)) {
      const cmp = compareVersions(version, policy.minSupported);
      blocked = cmp !== null && cmp < 0;
    }

    ok(res, {
      latest: policy.latest,
      minSupported: policy.minSupported,
      mode: policy.mode,
      url: policy.url,
      notes: policy.notes,
      blocked,
      current: version,
    });
  }

  return { handle, limiter: policyLimiter };
}
