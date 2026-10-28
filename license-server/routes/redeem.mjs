import { readJsonBody, failByCode, ok, clientIp, setCORS } from '../lib/http.mjs';
import { generateCode, normalizeContact, isValidEmail } from '../lib/store.mjs';
import { redeemPageHtml } from '../lib/redeem-page.mjs';

// GET /redeem → 自包含 HTML 页
// POST /v1/redeem → 发码或返回原码（同 contact 幂等）
// 这两个路由共用模块，由 server.mjs 按 method 分发
export async function handle(ctx, req, res) {
  // GET /redeem 只返回 HTML
  if (req.method === 'GET') {
    setCORS(res);
    const html = redeemPageHtml();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(html));
    res.end(html);
    return;
  }

  // POST /v1/redeem
  const { store, config, redeemLimiter, randomInt } = ctx;
  const ip = clientIp(req, config.trustProxy);

  // 领码限流：同一 IP 每小时 N 次（不分成功失败，公开入口）
  if (!redeemLimiter.check(ip)) {
    store.appendAudit({ ip, codePrefix: '', errorCode: 'rate_limited', event: 'redeem' });
    setCORS(res);
    failByCode(res, 'rate_limited', '领取过于频繁，请稍后再试');
    return;
  }

  const body = await readJsonBody(req);
  if (!body) {
    store.appendAudit({ ip, codePrefix: '', errorCode: 'bad_request', event: 'redeem' });
    setCORS(res);
    failByCode(res, 'bad_request', '请求体不是合法 JSON');
    return;
  }

  const contact = normalizeContact(body.contact);
  if (!isValidEmail(contact)) {
    store.appendAudit({ ip, codePrefix: '', errorCode: 'bad_contact', event: 'redeem' });
    setCORS(res);
    failByCode(res, 'bad_contact', '请填写一个可用的邮箱');
    return;
  }

  // 明示同意：不接受「默认勾选」或「提交即视为同意」。
  // 页面必须显式带 consent:true，否则拒发，避免日后扯不清有没有告知过。
  if (body.consent !== true) {
    store.appendAudit({ ip, codePrefix: '', errorCode: 'consent_required', event: 'redeem' });
    setCORS(res);
    failByCode(res, 'consent_required', '请先阅读并同意隐私说明');
    return;
  }

  // channel 非必填，给默认值 direct；不在白名单内也接受但不记录非法值
  const channel = config.redeemChannels.includes(body.channel) ? body.channel : 'direct';

  const code = generateCode(store, randomInt, config.codeFormat);
  const record = await store.issueCode({
    code,
    contact,
    channel,
    note: typeof body.note === 'string' ? body.note.slice(0, 200) : '',
  });

  setCORS(res);
  ok(res, {
    code: record.code,
    contact: record.contact,
    createdAt: record.createdAt,
  });
}
