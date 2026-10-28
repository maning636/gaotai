import { readJsonBody, failByCode, ok, clientIp, isValidMachine } from '../lib/http.mjs';
import { signToken } from '../lib/token.mjs';

// POST /v1/refresh
// 协议 §4.2：未绑定→machine_mismatch、吊销→code_revoked、成功重签 token 并更新 lastSeenAt
export async function handle(ctx, req, res) {
  const { store, config, rateLimiter, now } = ctx;
  const ip = clientIp(req, config.trustProxy);

  if (rateLimiter.isLimited(ip)) {
    store.appendAudit({ ip, codePrefix: '', errorCode: 'rate_limited', event: 'refresh' });
    failByCode(res, 'rate_limited', '请求过于频繁，请稍后再试');
    return;
  }

  const body = await readJsonBody(req);
  if (!body) {
    rateLimiter.recordFail(ip);
    store.appendAudit({ ip, codePrefix: '', errorCode: 'bad_request', event: 'refresh' });
    failByCode(res, 'bad_request', '请求体不是合法 JSON');
    return;
  }

  // 查码（兼容感知）：先按当前格式，匹配不到且格式非默认时再按旧格式试
  const { code } = store.resolveCode(body.code);
  if (!code || !isValidMachine(body.machine)) {
    rateLimiter.recordFail(ip);
    store.appendAudit({ ip, codePrefix: code ? code.slice(0, 7) : '', errorCode: 'bad_request', event: 'refresh' });
    failByCode(res, 'bad_request', code ? '机器码格式不正确' : '注册码格式不正确');
    return;
  }

  const result = await store.touchSeen(code, body.machine);
  if (!result.ok) {
    rateLimiter.recordFail(ip);
    store.appendAudit({ ip, codePrefix: code.slice(0, 7), errorCode: result.error, event: 'refresh' });
    const messages = {
      invalid_code: '注册码不存在',
      code_revoked: '该注册码已被吊销',
      machine_mismatch: '该机器未绑定此注册码',
    };
    failByCode(res, result.error, messages[result.error] || '刷新失败');
    return;
  }

  const record = result.record;
  const issuedAt = now();
  const expiresAt = issuedAt + config.tokenTtlMs;
  const payload = {
    v: 1,
    code: record.code,
    machine: body.machine,
    issuedAt,
    expiresAt,
    features: record.features,
    plan: record.plan,
  };
  const tokStr = signToken(config.privateKey, payload);
  store.setTokenExpiresAt(record.code, expiresAt);

  ok(res, {
    token: tokStr,
    expiresAt,
    features: record.features,
    plan: record.plan,
    code: record.code,
  });
}
