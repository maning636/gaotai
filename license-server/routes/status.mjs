import { readJsonBody, failByCode, ok, clientIp, isValidMachine } from '../lib/http.mjs';
import { normalizeCode } from '../lib/store.mjs';

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

  const code = normalizeCode(body.code);
  if (!code || !isValidMachine(body.machine)) {
    store.appendAudit({ ip, codePrefix: code ? code.slice(0, 7) : '', errorCode: 'bad_request', event: 'status' });
    failByCode(res, 'bad_request', code ? '机器码格式不正确' : '注册码格式不正确');
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
