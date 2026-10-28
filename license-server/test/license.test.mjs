import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSetup, issueCodeDirect, fakeMachine, verifyToken, decryptAsset, deriveAssetKey } from './helpers.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// 发码 → 激活成功 → token 验签、machine 正确、expiresAt ≈ now+30d
describe('激活与 token', () => {
  let s;
  beforeEach(async () => { s = makeSetup(); });
  afterEach(async () => { await s.close(); });

  test('发码后激活成功，token 可用公钥验签且字段正确', async () => {
    const code = await issueCodeDirect(s, 'wx_alice');
    const machine = fakeMachine('alice-pc');
    const base = await s.base();

    const r = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine, appVersion: '0.1.6', os: 'win32 10.0.19045' }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.data.code, code);
    assert.equal(j.data.plan, 'free');
    assert.ok(j.data.token.startsWith('gt1.'));

    // token 验签
    const v = verifyToken(s.pubPem, j.data.token);
    assert.equal(v.ok, true);
    assert.equal(v.payload.code, code);
    assert.equal(v.payload.machine, machine);
    assert.equal(v.payload.v, 1);
    assert.deepEqual(v.payload.features, ['core', 'skills', 'prompts', 'topics', 'layout-packs', 'illustration']);

    // expiresAt ≈ now + 30 天（允许 5 秒误差）
    const now = Date.now();
    const expected = now + 30 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(j.data.expiresAt - expected) < 5000, `expiresAt ${j.data.expiresAt} 应 ≈ ${expected}`);
    assert.equal(v.payload.expiresAt, j.data.expiresAt);
  });

  test('同码同机重复激活幂等放行，不消耗名额', async () => {
    const code = await issueCodeDirect(s, 'wx_bob');
    const machine = fakeMachine('bob-pc');
    const base = await s.base();

    const r1 = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });
    const j2 = await r2.json();
    assert.equal(r2.status, 200);
    assert.equal(j2.ok, true);
  });
});

// 同码不同机 → device_limit
describe('设备绑定', () => {
  let s;
  beforeEach(async () => { s = makeSetup(); });
  afterEach(async () => { await s.close(); });

  test('同码不同机激活 → device_limit (403)', async () => {
    const code = await issueCodeDirect(s, 'wx_carol');
    const base = await s.base();
    const m1 = fakeMachine('carol-pc1');
    const m2 = fakeMachine('carol-pc2');

    const r1 = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: m1 }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: m2 }),
    });
    const j2 = await r2.json();
    assert.equal(r2.status, 403);
    assert.equal(j2.ok, false);
    assert.equal(j2.error.code, 'device_limit');
  });

  test('maxDevices=2 时允许第二台机器', async () => {
    const code = await issueCodeDirect(s, 'wx_dave', { maxDevices: 2 });
    const base = await s.base();
    const m1 = fakeMachine('dave-1');
    const m2 = fakeMachine('dave-2');

    const r1 = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: m1 }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: m2 }),
    });
    assert.equal(r2.status, 200);

    const r3 = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: fakeMachine('dave-3') }),
    });
    const j3 = await r3.json();
    assert.equal(r3.status, 403);
    assert.equal(j3.error.code, 'device_limit');
  });
});

// 吊销后 refresh → code_revoked
// 未绑定机器 refresh → machine_mismatch
describe('刷新', () => {
  let s;
  beforeEach(async () => { s = makeSetup(); });
  afterEach(async () => { await s.close(); });

  test('吊销后 refresh → code_revoked (403)', async () => {
    const code = await issueCodeDirect(s, 'wx_eve');
    const machine = fakeMachine('eve-pc');
    const base = await s.base();

    await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });

    await s.app.ctx.store.revoke(code);

    const r = await fetch(base + '/v1/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine, appVersion: '0.1.6' }),
    });
    const j = await r.json();
    assert.equal(r.status, 403);
    assert.equal(j.error.code, 'code_revoked');
  });

  test('未绑定机器 refresh → machine_mismatch (403)', async () => {
    const code = await issueCodeDirect(s, 'wx_frank');
    const base = await s.base();
    const m1 = fakeMachine('frank-1');
    const m2 = fakeMachine('frank-2');

    // 用 m1 激活
    await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: m1 }),
    });

    // 用 m2 refresh → machine_mismatch
    const r = await fetch(base + '/v1/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: m2 }),
    });
    const j = await r.json();
    assert.equal(r.status, 403);
    assert.equal(j.error.code, 'machine_mismatch');
  });

  test('正常 refresh 成功并返回新 token', async () => {
    const code = await issueCodeDirect(s, 'wx_grace');
    const machine = fakeMachine('grace-pc');
    const base = await s.base();

    await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });

    const r = await fetch(base + '/v1/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine, appVersion: '0.1.6' }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.ok(j.data.token.startsWith('gt1.'));
    assert.equal(j.data.code, code);
  });
});

// status 接口
describe('状态查询', () => {
  let s;
  beforeEach(async () => { s = makeSetup(); });
  afterEach(async () => { await s.close(); });

  test('激活后 status 返回正确状态', async () => {
    const code = await issueCodeDirect(s, 'wx_heidi');
    const machine = fakeMachine('heidi-pc');
    const base = await s.base();

    await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });

    const r = await fetch(base + '/v1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.data.activated, true);
    assert.equal(j.data.revoked, false);
    assert.equal(j.data.plan, 'free');
    assert.ok(j.data.expiresAt > 0);
    assert.ok(j.data.lastSeenAt > 0);
  });

  test('不存在的 code → invalid_code (404)', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'GT-AAAA-BBBB-CCCC-DDDD', machine: fakeMachine('x') }),
    });
    const j = await r.json();
    assert.equal(r.status, 404);
    assert.equal(j.error.code, 'invalid_code');
  });
});

// 限流：6 次失败 → 第 6 次 rate_limited
// 注意：每个 setup 有独立 limiter，不会互相干扰
describe('限流', () => {
  let s;
  beforeEach(async () => { s = makeSetup(); });
  afterEach(async () => { await s.close(); });

  test('5 次失败后第 6 次 → rate_limited (429)', async () => {
    const base = await s.base();
    const machine = fakeMachine('ratelimit-pc');

    // 用一个不存在的 code 触发失败
    const badCode = 'GT-WXYZ-WXYZ-WXYZ-WXYZ';

    for (let i = 0; i < 5; i++) {
      const r = await fetch(base + '/v1/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: badCode, machine }),
      });
      const j = await r.json();
      assert.equal(j.error.code, 'invalid_code');
    }

    // 第 6 次应被限流
    const r6 = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: badCode, machine }),
    });
    const j6 = await r6.json();
    assert.equal(r6.status, 429);
    assert.equal(j6.error.code, 'rate_limited');
  });
});

// 资产加密：加密 → 用同一 token 派生密钥解密 → 明文 sha256 与 manifest 一致
// 过期/伪造 token 取资产返回 401
describe('资产', () => {
  let s;
  beforeEach(async () => {
    s = makeSetup();
    // 造一个测试资产包
    const files = { 'skills/demo.md': Buffer.from('# hello').toString('base64') };
    const a = s.seedAsset('skills', '2026-10-28', files);
    s.seedManifest('2026-10-28', [a]);
  });
  afterEach(async () => { await s.close(); });

  test('有效 token 取 manifest 成功', async () => {
    const code = await issueCodeDirect(s, 'wx_asset1');
    const machine = fakeMachine('asset-pc1');
    const base = await s.base();

    const act = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });
    const actJ = await act.json();
    const token = actJ.data.token;

    const r = await fetch(base + '/v1/assets/manifest', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.data.version, '2026-10-28');
    assert.equal(j.data.assets.length, 1);
    assert.equal(j.data.assets[0].name, 'skills');
  });

  test('加密资产可用同 token 派生密钥解密，sha256 与 manifest 一致', async () => {
    const code = await issueCodeDirect(s, 'wx_asset2');
    const machine = fakeMachine('asset-pc2');
    const base = await s.base();

    const act = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });
    const actJ = await act.json();
    const token = actJ.data.token;

    // 取资产
    const r = await fetch(base + '/v1/assets/skills?version=2026-10-28', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.data.name, 'skills');
    assert.equal(j.data.version, '2026-10-28');

    // 用同一 token 派生密钥解密
    const key = deriveAssetKey(token, 'skills', '2026-10-28');
    const plain = decryptAsset(key, j.data.iv, j.data.tag, j.data.data);

    // 明文 sha256 应与 plainSha256 一致
    const sha = createHash('sha256').update(plain).digest('hex');
    assert.equal(sha, j.data.plainSha256);

    // 解出来的 JSON 结构正确
    const obj = JSON.parse(plain.toString('utf8'));
    assert.equal(obj.version, '2026-10-28');
    assert.ok(obj.files['skills/demo.md']);
  });

  test('伪造 token 取资产 → 401', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/assets/manifest', {
      headers: { Authorization: 'Bearer gt1.fake.invalid.sig' },
    });
    const j = await r.json();
    assert.equal(r.status, 401);
    assert.equal(j.error.code, 'unauthorized');
  });

  test('无 Authorization 头 → 401', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/assets/manifest');
    const j = await r.json();
    assert.equal(r.status, 401);
    assert.equal(j.error.code, 'unauthorized');
  });

  test('version 不匹配 → 404', async () => {
    const code = await issueCodeDirect(s, 'wx_asset3');
    const machine = fakeMachine('asset-pc3');
    const base = await s.base();

    const act = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });
    const token = (await act.json()).data.token;

    const r = await fetch(base + '/v1/assets/skills?version=2099-01-01', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const j = await r.json();
    assert.equal(r.status, 404);
    assert.equal(j.error.code, 'not_found');
  });

  test('过期 token 取资产 → 401', async () => {
    const code = await issueCodeDirect(s, 'wx_asset_exp');
    const machine = fakeMachine('asset-exp-pc');
    const base = await s.base();

    // 手工签一个已过期的 token：expiresAt 设为过去
    const { signToken } = await import('../lib/token.mjs');
    const expiredPayload = {
      v: 1,
      code,
      machine,
      issuedAt: Date.now() - 60000,
      expiresAt: Date.now() - 1000,
      features: ['core'],
      plan: 'free',
    };
    const expiredToken = signToken(s.privPem, expiredPayload);

    const r = await fetch(base + '/v1/assets/manifest', {
      headers: { Authorization: 'Bearer ' + expiredToken },
    });
    const j = await r.json();
    assert.equal(r.status, 401);
    assert.equal(j.error.code, 'unauthorized');
  });
});

// 审计日志不含完整 contact
describe('审计日志', () => {
  let s;
  beforeEach(async () => { s = makeSetup(); });
  afterEach(async () => { await s.close(); });

  test('审计日志含 code 前 4 位、IP、错误码，不含完整 contact', async () => {
    const code = await issueCodeDirect(s, 'wx_audit_test_contact_xyz');
    const base = await s.base();
    const machine = fakeMachine('audit-pc');

    // 触发一次失败：用不同机器激活已达上限的码
    await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine }),
    });
    // 第二台机器触发 device_limit
    await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: fakeMachine('other') }),
    });

    const auditPath = s.app.ctx.store._auditPath;
    assert.ok(existsSync(auditPath));
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);

    assert.ok(lines.length > 0, '审计日志应有记录');
    for (const line of lines) {
      const entry = JSON.parse(line);
      // 不含完整 contact
      assert.equal(JSON.stringify(entry).includes('wx_audit_test_contact_xyz'), false, '审计日志不得含完整 contact');
      // 应有字段
      assert.ok('t' in entry);
      assert.ok('ip' in entry);
      assert.ok('codePrefix' in entry);
      assert.ok('errorCode' in entry);
    }
  });
});

// 领码
describe('领码', () => {
  let s;
  beforeEach(async () => { s = makeSetup(); });
  afterEach(async () => { await s.close(); });

  test('POST /v1/redeem 成功返回 code', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: 'someone@example.com', channel: 'direct', consent: true }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.ok(j.data.code.startsWith('GT-'));
    assert.equal(j.data.contact, 'someone@example.com');
    assert.ok(j.data.createdAt > 0);
  });

  test('同 contact 重复提交返回原码（幂等）', async () => {
    const base = await s.base();
    const r1 = await fetch(base + '/v1/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: 'dup@example.com', channel: 'direct', consent: true }),
    });
    const j1 = await r1.json();
    const r2 = await fetch(base + '/v1/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: 'DUP@Example.com', channel: 'direct', consent: true }),
    });
    const j2 = await r2.json();
    assert.equal(j1.data.code, j2.data.code);
  });

  test('邮箱规范化：trim + 小写，重复领取返回原码', async () => {
    const base = await s.base();
    const r1 = await fetch(base + '/v1/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: '  Trim.Me@Example.COM  ', consent: true }),
    });
    const j1 = await r1.json();
    const r2 = await fetch(base + '/v1/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: 'trim.me@example.com', consent: true }),
    });
    const j2 = await r2.json();
    assert.equal(j1.data.contact, 'trim.me@example.com');
    assert.equal(j1.data.code, j2.data.code);
  });

  test('未同意隐私说明 → 400 consent_required', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: 'no-consent@example.com' }),
    });
    const j = await r.json();
    assert.equal(r.status, 400);
    assert.equal(j.error.code, 'consent_required');
  });

  test('邮箱格式不对 → 400 bad_contact', async () => {
    const base = await s.base();
    for (const bad of ['not-an-email', 'a@b', 'a b@c.com', '']) {
      const r = await fetch(base + '/v1/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: bad, consent: true }),
      });
      const j = await r.json();
      assert.equal(r.status, 400, '应拒绝：' + bad);
      assert.equal(j.error.code, 'bad_contact');
    }
  });

  test('bad_contact → 400', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: 'x', consent: true }),
    });
    const j = await r.json();
    assert.equal(r.status, 400);
    assert.equal(j.error.code, 'bad_contact');
  });

  test('GET /redeem 返回 HTML（含邮箱字段与隐私同意）', async () => {
    const base = await s.base();
    const r = await fetch(base + '/redeem');
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('<!DOCTYPE html>'));
    assert.ok(text.includes('type="email"'));
    assert.ok(text.includes('隐私说明'));
    assert.ok(text.includes('/v1/redeem'));
    assert.ok(text.includes('复制'));
  });

  test('领码页里不能出现被吞掉反斜杠的残留（模板字符串陷阱）', async () => {
    const base = await s.base();
    const text = await (await fetch(base + '/redeem')).text();
    // 页面由模板字符串拼出，正则里的反斜杠会被当成转义吞掉：
    // /\/redeem\/?$/ 会变成 //redeem/?$/（JS 里 // 是注释，整段脚本语法错误），
    // /[^\s@]/ 会变成 [^s@]（把字母 s 当成禁用字符，带 s 的邮箱全被判非法）。
    assert.ok(!text.includes('replace(//'), '出现了被吞掉反斜杠的正则开头');
    assert.ok(!text.includes('[^s@]'), '出现了被吞掉反斜杠的字符类');
  });

  test('GET /privacy 返回隐私说明', async () => {
    const base = await s.base();
    const r = await fetch(base + '/privacy');
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('隐私说明'));
    assert.ok(text.includes('邮箱'));
    assert.ok(text.includes('机器码'));
  });
});
