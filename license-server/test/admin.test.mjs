// 网页后台（/admin）路由测试：真实 HTTP 起服务，用 fetch 走完整链路。
//
// 覆盖（对应需求 5 的用例清单）：
//  - 未配置 ADMIN_PASSWORD → /admin 503
//  - 未登录 GET /admin → 200 登录页（无码列表）
//  - 错误口令 → 200 登录页含「口令不正确」；连续失败后锁定
//  - 正确口令 → 303 + Set-Cookie（HttpOnly + SameSite=Strict）
//  - 登录后 GET /admin 含刚发的码
//  - action=issue/revoke/unbind 生效
//  - 未登录 POST /admin/action → 401
//  - 跨站 Origin POST → 403
//  - 响应头 X-Robots-Tag: noindex

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomInt, createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server.mjs';
import { DEFAULT_CODE_FORMAT } from '../lib/store.mjs';

const ADMIN_PASSWORD = 'test-admin-pass';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

// 独立 setup：adminPassword 由用例注入，未配置时留空字符串。
function makeAdminSetup(opts = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const dataDir = mkdtempSync(join(tmpdir(), 'ls-admin-'));

  const config = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    privateKeyPath: dataDir + '/fake.pem',
    assetsDir: mkdtempSync(join(tmpdir(), 'ls-admin-assets-')),
    trustProxy: false,
    tokenTtlDays: 30,
    tokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    rateFails: 5,
    rateWindowMs: 5 * 60 * 1000,
    redeemPerHour: 20,
    redeemChannels: ['wechat-mp', 'wechat-oa', 'direct'],
    codeFormat: { ...DEFAULT_CODE_FORMAT },
    privateKey: privPem,
    publicKey: pubPem,
    randomInt,
    // 后台凭据：默认配置为测试口令；用例可传 adminPassword:'' 模拟未配置
    adminPassword: opts.adminPassword ?? ADMIN_PASSWORD,
    adminSessionSecret: opts.adminSessionSecret ?? SESSION_SECRET,
  };

  const app = createApp({ config });
  const server = createServer((req, res) => app.handler(req, res));
  const started = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  async function base() {
    return 'http://127.0.0.1:' + (await started);
  }
  async function close() {
    app.close();
    await new Promise((r) => server.close(r));
  }
  return { config, app, server, base, close };
}

// 登录并返回 cookie 字符串（gt_admin=...）
async function login(base, password = ADMIN_PASSWORD) {
  const r = await fetch(base + '/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/gt_admin=([^;]+)/);
  return { status: r.status, cookie: m ? 'gt_admin=' + m[1] : '', setCookie };
}

function fakeMachine(seed) {
  return createHash('sha256').update(seed).digest('hex');
}

describe('后台 /admin', () => {
  describe('未配置 ADMIN_PASSWORD', () => {
    let s;
    beforeEach(async () => { s = makeAdminSetup({ adminPassword: '' }); });
    afterEach(async () => { await s.close(); });

    test('GET /admin → 503，页面提示未配置口令', async () => {
      const base = await s.base();
      const r = await fetch(base + '/admin');
      const text = await r.text();
      assert.equal(r.status, 503);
      assert.ok(text.includes('未配置后台口令'));
    });

    test('POST /admin/login → 503（不提供登录入口）', async () => {
      const base = await s.base();
      const r = await fetch(base + '/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'x' }),
      });
      assert.equal(r.status, 503);
    });
  });

  describe('已配置口令', () => {
    let s;
    beforeEach(async () => { s = makeAdminSetup(); });
    afterEach(async () => { await s.close(); });

    test('未登录 GET /admin → 200 登录页，且不含码列表', async () => {
      const base = await s.base();
      const r = await fetch(base + '/admin');
      const text = await r.text();
      assert.equal(r.status, 200);
      assert.ok(text.includes('后台登录'));
      assert.ok(text.includes('type="password"'));
      // 登录页不应出现控制台独有元素（发码表单 / 码列表操作按钮）
      assert.ok(!text.includes('发放注册码'));
      assert.ok(!text.includes('吊销'));
      assert.ok(!text.includes('action="issue"'));
    });

    test('响应头含 X-Robots-Tag: noindex 与 Cache-Control: no-store', async () => {
      const base = await s.base();
      const r = await fetch(base + '/admin');
      assert.equal(r.headers.get('x-robots-tag'), 'noindex');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    });

    test('错误口令 → 200 登录页含「口令不正确」', async () => {
      const base = await s.base();
      const r = await fetch(base + '/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'wrong' }),
      });
      const text = await r.text();
      assert.equal(r.status, 200);
      assert.ok(text.includes('口令不正确'));
      // 失败不应发会话 cookie
      assert.equal(r.headers.get('set-cookie'), null);
    });

    test('连续失败后锁定：第 6 次起提示失败次数过多', async () => {
      const base = await s.base();
      for (let i = 0; i < 5; i++) {
        const r = await fetch(base + '/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ password: 'wrong' }),
        });
        assert.equal(r.status, 200);
      }
      // 第 6 次：应被锁（即使口令正确也拒绝，防爆破）
      const r6 = await fetch(base + '/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: ADMIN_PASSWORD }),
      });
      const text6 = await r6.text();
      assert.equal(r6.status, 200);
      assert.ok(text6.includes('失败次数过多'));
    });

    test('正确口令 → 303 + Set-Cookie 带 HttpOnly 与 SameSite=Strict', async () => {
      const base = await s.base();
      const { status, setCookie } = await login(base);
      assert.equal(status, 303);
      assert.ok(setCookie.includes('HttpOnly'));
      assert.ok(setCookie.includes('SameSite=Strict'));
      assert.ok(setCookie.includes('Path=/admin'));
      assert.ok(!setCookie.toLowerCase().includes('secure'), '非 HTTPS 不应加 Secure');
    });

    test('登录后 GET /admin 含刚发的码', async () => {
      const base = await s.base();
      const { cookie } = await login(base);
      // 直接经 store 发一个码
      const { generateCode } = await import('../lib/store.mjs');
      const code = generateCode(s.app.ctx.store, s.config.randomInt, s.config.codeFormat);
      const record = await s.app.ctx.store.issueCode({
        code,
        contact: 'admin_test@example.com',
        channel: 'direct',
        note: '后台测试',
        maxDevices: 2,
      });
      const r = await fetch(base + '/admin', { headers: { Cookie: cookie } });
      const text = await r.text();
      assert.equal(r.status, 200);
      assert.ok(text.includes(record.code));
      assert.ok(text.includes('admin_test@example.com'));
    });

    test('未登录 POST /admin/action → 401', async () => {
      const base = await s.base();
      const r = await fetch(base + '/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'issue', contact: 'a@b.com' }),
      });
      assert.equal(r.status, 401);
    });

    test('跨站 Origin 的 POST → 403', async () => {
      const base = await s.base();
      const { cookie } = await login(base);
      const r = await fetch(base + '/admin/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
          Origin: 'https://evil.example.com',
        },
        body: new URLSearchParams({ action: 'issue', contact: 'x@y.com' }),
      });
      assert.equal(r.status, 403);
    });

    test('action=issue 发码成功；revoke 后列表显示已吊销；unbind 后设备归零', async () => {
      const base = await s.base();
      const { cookie } = await login(base);

      // issue：发一个 maxDevices=2 的码
      const issueR = await fetch(base + '/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ action: 'issue', contact: 'e2e@example.com', note: '手工测试', maxDevices: '2' }),
        redirect: 'manual',
      });
      assert.equal(issueR.status, 303);
      assert.match(issueR.headers.get('location') || '', /\/admin\?msg=/);

      // 从 store 里找到刚发的码
      const list = await s.app.ctx.store.listCodes();
      const rec = list.find((c) => c.contact === 'e2e@example.com');
      assert.ok(rec, '应能找到刚发的码');
      assert.equal(rec.maxDevices, 2);
      assert.equal(rec.revoked, false);

      // 绑两台机器（直接经 store），验证 unbind 会清空
      await s.app.ctx.store.bindOrAllow(rec.code, fakeMachine('e2e-1'));
      await s.app.ctx.store.bindOrAllow(rec.code, fakeMachine('e2e-2'));
      const afterBind = await s.app.ctx.store.findCode(rec.code);
      assert.equal(afterBind.devices.length, 2);

      // unbind → 设备归零
      const unbindR = await fetch(base + '/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ action: 'unbind', code: rec.code }),
        redirect: 'manual',
      });
      assert.equal(unbindR.status, 303);
      const afterUnbind = await s.app.ctx.store.findCode(rec.code);
      assert.equal(afterUnbind.devices.length, 0);

      // revoke → 已吊销
      const revokeR = await fetch(base + '/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ action: 'revoke', code: rec.code }),
        redirect: 'manual',
      });
      assert.equal(revokeR.status, 303);
      const afterRevoke = await s.app.ctx.store.findCode(rec.code);
      assert.equal(afterRevoke.revoked, true);

      // 控制台页面显示已吊销
      const page = await fetch(base + '/admin', { headers: { Cookie: cookie } });
      const text = await page.text();
      assert.ok(text.includes('已吊销'));
      assert.ok(text.includes(rec.code));

      // 审计日志里应有 admin:issue / admin:revoke / admin:unbind 事件
      const { readFileSync } = await import('node:fs');
      const audit = readFileSync(s.app.ctx.store._auditPath, 'utf8');
      for (const ev of ['admin:issue', 'admin:revoke', 'admin:unbind']) {
        assert.ok(audit.includes(ev), `审计应含 ${ev}`);
      }
    });

    test('logout 清 cookie，浏览器丢弃后再访问 /admin 回登录页', async () => {
      const base = await s.base();
      const { cookie } = await login(base);
      const r = await fetch(base + '/admin/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        redirect: 'manual',
      });
      assert.equal(r.status, 303);
      // 响应必须下发明文清空 cookie（Max-Age=0），浏览器据此丢弃会话
      assert.ok((r.headers.get('set-cookie') || '').includes('Max-Age=0'));

      // 模拟浏览器已丢弃 cookie：不带 cookie（或带空 cookie）访问 → 登录页
      const after = await fetch(base + '/admin', { headers: { Cookie: 'gt_admin=' } });
      const text = await after.text();
      assert.ok(text.includes('后台登录'));
      assert.ok(!text.includes('发放注册码'));
    });
  });

  describe('后台文案编辑 /admin/texts', () => {
    let s;
    beforeEach(async () => { s = makeAdminSetup(); });
    afterEach(async () => { await s.close(); });

    test('未登录 GET /admin/texts → 200 登录页', async () => {
      const base = await s.base();
      const r = await fetch(base + '/admin/texts');
      const text = await r.text();
      assert.equal(r.status, 200);
      assert.ok(text.includes('后台登录'));
      assert.ok(!text.includes('保存文案'));
    });

    test('未登录 POST /admin/texts → 401', async () => {
      const base = await s.base();
      const r = await fetch(base + '/admin/texts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ welcome: 'x' }),
      });
      assert.equal(r.status, 401);
    });

    test('登录后 GET /admin/texts 预填当前生效内容', async () => {
      const base = await s.base();
      const { cookie } = await login(base);
      const r = await fetch(base + '/admin/texts', { headers: { Cookie: cookie } });
      const text = await r.text();
      assert.equal(r.status, 200);
      assert.ok(text.includes('文案与关键词'));
      assert.ok(text.includes('保存文案'));
      // 预填了默认欢迎语（当前生效内容）
      assert.ok(text.includes('谢谢你关注'));
      assert.ok(text.includes('当前生效'));
    });

    test('登录后保存成功 → 303 且 wechat.json 内容确实变了', async () => {
      const base = await s.base();
      const { cookie } = await login(base);
      const form = new URLSearchParams({
        welcome: '【新欢迎】你好呀',
        fallback: '新兜底',
        faq: '怎么用,激活=这是新激活步骤\\n第二行',
        p0_name: '稿台',
        p0_keywords: '稿台,写作',
        p0_key: 'gaotai',
        p0_suffix: '后缀',
        p0_issue: '1',
        p0_url: 'https://example.com',
      });
      const r = await fetch(base + '/admin/texts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: form,
        redirect: 'manual',
      });
      assert.equal(r.status, 303);
      assert.match(r.headers.get('location') || '', /\/admin\/texts\?msg=/);

      // 读盘确认真的变了
      const { readFileSync } = await import('node:fs');
      const cfg = JSON.parse(readFileSync(join(s.config.dataDir, 'wechat.json'), 'utf8'));
      assert.equal(cfg.welcome, '【新欢迎】你好呀');
      assert.equal(cfg.fallback, '新兜底');
      assert.equal(cfg.faq[0].reply, '这是新激活步骤\n第二行'); // 字面 \n 被转成换行
      assert.deepEqual(cfg.faq[0].keywords, ['怎么用', '激活']);
      assert.equal(cfg.products[0].name, '稿台');

      // 再 GET /admin/texts 看到新内容
      const page = await fetch(base + '/admin/texts', { headers: { Cookie: cookie } });
      const text = await page.text();
      assert.ok(text.includes('【新欢迎】你好呀'));
    });

    test('保存非法内容（faq 行缺 =）→ 页面显示错误且文件未变', async () => {
      const base = await s.base();
      const { cookie } = await login(base);
      const { readFileSync } = await import('node:fs');
      const cfgPath = join(s.config.dataDir, 'wechat.json');
      const before = readFileSync(cfgPath, 'utf8');

      const form = new URLSearchParams({
        welcome: 'x',
        fallback: 'y',
        faq: '怎么用=ok\n没有等号这一行',
        p0_name: '稿台',
        p0_keywords: '稿台',
        p0_key: 'gaotai',
        p0_suffix: '',
        p0_issue: '1',
        p0_url: '',
      });
      const r = await fetch(base + '/admin/texts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: form,
        redirect: 'manual',
      });
      const text = await r.text();
      assert.equal(r.status, 200); // 留在同页
      assert.ok(text.includes('缺少「=」')); // 显示错误
      // 文件未变
      assert.equal(readFileSync(cfgPath, 'utf8'), before);
    });

    test('保存非法内容（产品无关键词）→ 页面显示错误且文件未变', async () => {
      const base = await s.base();
      const { cookie } = await login(base);
      const { readFileSync } = await import('node:fs');
      const cfgPath = join(s.config.dataDir, 'wechat.json');
      const before = readFileSync(cfgPath, 'utf8');

      const form = new URLSearchParams({
        welcome: 'x',
        fallback: 'y',
        faq: '',
        p0_name: '稿台',
        p0_keywords: '',
        p0_key: 'gaotai',
        p0_suffix: '',
        p0_issue: '1',
        p0_url: '',
      });
      const r = await fetch(base + '/admin/texts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: form,
        redirect: 'manual',
      });
      const text = await r.text();
      assert.equal(r.status, 200);
      assert.ok(text.includes('没有关键词'));
      assert.equal(readFileSync(cfgPath, 'utf8'), before);
    });
  });
});
