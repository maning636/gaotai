import { readJsonBody, failByCode, ok, clientIp, isValidMachine } from '../lib/http.mjs';

// POST /v1/status
// 协议 §4.3：查询激活状态、吊销、过期时间、最后在线时间
export async function handle(ctx, req, res) {
  const { store, config } = ctx;
  const ip = clientIp(req, config.trustProxy);

  const body = await readJsonBody(req);
  if (!body) {
    store.appendAudit({ ip, codePrefix: '', errorCode: 'bad_request', event: 'status' });
    failByCode(res, 'bad_request', '请求体不是合法 JSON');
    return;
  }

  // 查码（兼容感知）：先按当前格式，匹配不到且格式非默认时再按旧格式试
  const { code, record } = store.resolveCode(body.code);
  if (!code || !isValidMachine(body.machine)) {
    store.appendAudit({ ip, codePrefix: code ? code.slice(0, 7) : '', errorCode: 'bad_request', event: 'status' });
    failByCode(res, 'bad_request', code ? '机器码格式不正确' : '注册码格式不正确');
    return;
  }
  if (!record) {
    store.appendAudit({ ip, codePrefix: code.slice(0, 7), errorCode: 'invalid_code', event: 'status' });
    failByCode(res, 'invalid_code', '注册码不存在');
    return;
  }

  const result = await store.statusOf(code, body.machine);
  if (!result.ok) {
    store.appendAudit({ ip, codePrefix: code.slice(0, 7), errorCode: result.error, event: 'status' });
    failByCode(res, result.error, '注册码不存在');
    return;
  }

  ok(res, result.data);
}
