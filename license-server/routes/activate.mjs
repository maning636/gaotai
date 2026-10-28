import { readJsonBody, failByCode, ok, clientIp, isValidMachine } from '../lib/http.mjs';
import { normalizeCode } from '../lib/store.mjs';
import { signToken } from '../lib/token.mjs';

// POST /v1/activate
// 协议 §4.1：绑定规则、限流、签发 token
// handle(ctx, req, res)
export async function handle(ctx, req, res) {
  const { store, config, rateLimiter, now } = ctx;
  const ip = clientIp(req, config.trustProxy);

  // 限流前置：已被限流的 IP 直接拒绝，不再读 body
  if (rateLimiter.isLimited(ip)) {
    store.appendAudit({ ip, codePrefix: '', errorCode: 'rate_limited', event: 'activate' });
    failByCode(res, 'rate_limited', '请求过于频繁，请稍后再试');
    return;
  }

  const body = await readJsonBody(req);
  if (!body) {
    rateLimiter.recordFail(ip);
    store.appendAudit({ ip, codePrefix: '', errorCode: 'bad_request', event: 'activate' });
    failByCode(res, 'bad_request', '请求体不是合法 JSON');
    return;
  }

  // 规范化注册码：大写、去空格、补格式
  const code = normalizeCode(body.code);
  if (!code) {
    rateLimiter.recordFail(ip);
    store.appendAudit({ ip, codePrefix: '', errorCode: 'bad_request', event: 'activate' });
    failByCode(res, 'bad_request', '注册码格式不正确');
    return;
  }

  if (!isValidMachine(body.machine)) {
    rateLimiter.recordFail(ip);
    // code 前 4 位这里用 code 的前两段前缀
    store.appendAudit({ ip, codePrefix: code.slice(0, 7), errorCode: 'bad_request', event: 'activate' });
    failByCode(res, 'bad_request', '机器码格式不正确');
    return;
  }

  const result = await store.bindOrAllow(code, body.machine);
  if (!result.ok) {
    // 失败才计限流，成功不计
    rateLimiter.recordFail(ip);
    store.appendAudit({ ip, codePrefix: code.slice(0, 7), errorCode: result.error, event: 'activate' });

    const messages = {
      invalid_code: '注册码不存在',
      code_revoked: '该注册码已被吊销',
      device_limit: '该注册码已达设备数量上限',
    };
    failByCode(res, result.error, messages[result.error] || '激活失败');
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
  // 记录最新 token 过期时间，供 status 查询
  store.setTokenExpiresAt(record.code, expiresAt);

  ok(res, {
    token: tokStr,
    expiresAt,
    features: record.features,
    plan: record.plan,
    code: record.code,
  });
}
