// 客户端版本策略测试：单元（compareVersions / validatePolicy / saveAppPolicy）
// + 真实 HTTP（/v1/app/policy 与 /admin/version）。
//
// 覆盖（对应需求 4 的用例清单）：
//  - compareVersions：0.2.0 < 0.10.0；1.0 == 1.0.0；非法输入返回 null
//  - /v1/app/policy：正常返回；version 低于 minSupported → blocked:true；
//    高于 → false；缺 version → false；非法 version → false 且 200
//  - 限流：60 次内正常，第 61 次 429（阈值 perMinute=60）
//  - saveAppPolicy：合法写入并读回；非法（mode 错 / url 非 https / 版本号非法）
//    被拒且原文件未变
//  - /admin/version：未登录 GET 200 登录页 / POST 401；登录后保存成功、页面显示新值；
//    保存非法内容报错且文件未变

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server.mjs';
import { DEFAULT_CODE_FORMAT } from '../lib/store.mjs';
import {
  compareVersions,
  validatePolicy,
  loadAppPolicy,
  saveAppPolicy,
  DEFAULT_APP_POLICY,
} from '../lib/app-policy.mjs';

const ADMIN_PASSWORD = 'test-admin-pass';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

// 独立 setup：起真实 HTTP 服务（adminPassword 默认测试口令）。
function makePolicySetup(opts = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const dataDir = mkdtempSync(join(tmpdir(), 'ls-policy-'));

  const config = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    privateKeyPath: dataDir + '/fake.pem',
    assetsDir: mkdtempSync(join(tmpdir(), 'ls-policy-assets-')),
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

describe('版本策略：compareVersions', () => {
  test('0.2.0 < 0.10.0（按段比较，不做字符串比较）', () => {
    assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
    assert.equal(compareVersions('0.10.0', '0.2.0'), 1);
  });

  test('1.0 == 1.0.0（缺位按 0 补齐）', () => {
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('1', '1.0.0'), 0);
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
  });

  test('0.9.9 < 1.0.0 与 1.2.3 > 1.2.2', () => {
    assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
    assert.equal(compareVersions('1.2.3', '1.2.2'), 1);
  });

  test('非法输入返回 null（空串 / 字母 / 前缀 / 超 3 段 / 非字符串）', () => {
    assert.equal(compareVersions('', '1.0.0'), null);
    assert.equal(compareVersions('abc', '1.0.0'), null);
    assert.equal(compareVersions('v1.2.3', '1.0.0'), null);
    assert.equal(compareVersions('1.2.3.4', '1.0.0'), null);
    assert.equal(compareVersions('1.2.3', '1.0.x'), null); // 一侧非法即 null
    assert.equal(compareVersions('1.2.3', '1.0'), 1); // 两侧都合法，正常比较
    assert.equal(compareVersions(123, '1.0.0'), null);
    assert.equal(compareVersions(null, '1.0.0'), null);
  });
});

describe('版本策略：validatePolicy / load / save', () => {
  test('默认策略合法', () => {
    assert.equal(validatePolicy({ ...DEFAULT_APP_POLICY }).ok, true);
  });

  test('非法 mode / 非 https url / 非法版本号都被拒', () => {
    assert.equal(validatePolicy({ ...DEFAULT_APP_POLICY, mode: 'ftp' }).ok, false);
    assert.equal(validatePolicy({ ...DEFAULT_APP_POLICY, url: 'http://x.com/a' }).ok, false);
    assert.equal(validatePolicy({ ...DEFAULT_APP_POLICY, url: 'pan.quark.cn/s/x' }).ok, false);
    assert.equal(validatePolicy({ ...DEFAULT_APP_POLICY, latest: 'abc' }).ok, false);
    assert.equal(validatePolicy({ ...DEFAULT_APP_POLICY, minSupported: '0.x' }).ok, false);
    assert.equal(validatePolicy({ ...DEFAULT_APP_POLICY, notes: 'x'.repeat(2001) }).ok, false);
  });

  test('缺文件时 load 写默认并返回默认值', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-policy-load-'));
    const { config } = loadAppPolicy(dataDir);
    assert.deepEqual(config, { ...DEFAULT_APP_POLICY });
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8'));
    assert.deepEqual(onDisk, { ...DEFAULT_APP_POLICY });
  });

  test('load 用默认值补齐缺失键', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-policy-merge-'));
    writeFileSync(join(dataDir, 'app.json'), JSON.stringify({ latest: '0.3.0' }), 'utf8');
    const { config } = loadAppPolicy(dataDir);
    assert.equal(config.latest, '0.3.0');
    assert.equal(config.minSupported, DEFAULT_APP_POLICY.minSupported); // 缺键补齐
    assert.equal(config.mode, DEFAULT_APP_POLICY.mode);
  });

  test('坏文件（非法 JSON / 字段形状错）降级默认值', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-policy-bad-'));
    writeFileSync(join(dataDir, 'app.json'), '{not json', 'utf8');
    const a = loadAppPolicy(dataDir);
    assert.deepEqual(a.config, { ...DEFAULT_APP_POLICY });

    writeFileSync(join(dataDir, 'app.json'), JSON.stringify({ latest: 'abc', mode: 'bad' }), 'utf8');
    const b = loadAppPolicy(dataDir);
    assert.deepEqual(b.config, { ...DEFAULT_APP_POLICY });
  });

  test('saveAppPolicy 合法写入并读回', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-policy-save-'));
    const obj = {
      latest: '0.3.0',
      minSupported: '0.2.5',
      mode: 'link',
      url: 'https://pan.quark.cn/s/abc',
      notes: '新版本说明',
    };
    const r = saveAppPolicy(dataDir, obj);
    assert.equal(r.ok, true);
    const { config } = loadAppPolicy(dataDir);
    assert.deepEqual(config, obj);
  });

  test('saveAppPolicy 非法被拒且原文件未变', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-policy-reject-'));
    const path = join(dataDir, 'app.json');
    writeFileSync(path, JSON.stringify({ ...DEFAULT_APP_POLICY }), 'utf8');
    const before = readFileSync(path, 'utf8');

    // mode 错
    assert.equal(saveAppPolicy(dataDir, { ...DEFAULT_APP_POLICY, mode: 'ftp' }).ok, false);
    // url 非 https
    assert.equal(saveAppPolicy(dataDir, { ...DEFAULT_APP_POLICY, url: 'http://x.com' }).ok, false);
    // 版本号非法
    assert.equal(saveAppPolicy(dataDir, { ...DEFAULT_APP_POLICY, latest: 'abc' }).ok, false);

    assert.equal(readFileSync(path, 'utf8'), before, '非法保存不应覆盖原文件');
  });
});

describe('GET /v1/app/policy', () => {
  let s;
  beforeEach(async () => { s = makePolicySetup(); });
  afterEach(async () => { await s.close(); });

  test('正常返回（缺省默认策略，blocked:false）', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/app/policy?version=0.2.0');
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.data.latest, DEFAULT_APP_POLICY.latest);
    assert.equal(j.data.minSupported, DEFAULT_APP_POLICY.minSupported);
    assert.equal(j.data.mode, DEFAULT_APP_POLICY.mode);
    assert.equal(j.data.url, DEFAULT_APP_POLICY.url);
    assert.equal(j.data.current, '0.2.0');
    assert.equal(j.data.blocked, false);
  });

  test('version 低于 minSupported → blocked:true', async () => {
    const base = await s.base();
    // 把 minSupported 提到 0.3.0
    const saved = saveAppPolicy(s.config.dataDir, {
      latest: '0.3.0',
      minSupported: '0.3.0',
      mode: 'link',
      url: 'https://pan.quark.cn/s/x',
      notes: '',
    });
    assert.equal(saved.ok, true);
    const r = await fetch(base + '/v1/app/policy?version=0.2.0');
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.data.blocked, true);
  });

  test('version 高于 minSupported → blocked:false', async () => {
    const base = await s.base();
    saveAppPolicy(s.config.dataDir, {
      latest: '0.3.0',
      minSupported: '0.2.5',
      mode: 'link',
      url: 'https://pan.quark.cn/s/x',
      notes: '',
    });
    const r = await fetch(base + '/v1/app/policy?version=0.3.0');
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.data.blocked, false);
  });

  test('缺 version → blocked:false（不锁死探测请求）', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/app/policy');
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.data.blocked, false);
    assert.equal(j.data.current, '');
  });

  test('非法 version → blocked:false 且 200（脏数据不把接口打挂）', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/app/policy?version=abc');
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.data.blocked, false);
  });

  test('不需要登录/token：无 Authorization 头也可访问', async () => {
    const base = await s.base();
    const r = await fetch(base + '/v1/app/policy?version=0.2.0');
    assert.equal(r.status, 200);
  });
});

describe('GET /v1/app/policy 限流', () => {
  let s;
  beforeEach(async () => { s = makePolicySetup(); });
  afterEach(async () => { await s.close(); });

  test('同 IP 每分钟 60 次内正常，第 61 次 429', async () => {
    const base = await s.base();
    // 前 60 次：全部 200
    for (let i = 0; i < 60; i++) {
      const r = await fetch(base + '/v1/app/policy?version=0.2.0');
      assert.equal(r.status, 200, `第 ${i + 1} 次应 200`);
    }
    // 第 61 次：429
    const r61 = await fetch(base + '/v1/app/policy?version=0.2.0');
    const j61 = await r61.json();
    assert.equal(r61.status, 429);
    assert.equal(j61.error.code, 'rate_limited');
  });
});

describe('后台版本策略 /admin/version', () => {
  let s;
  beforeEach(async () => { s = makePolicySetup(); });
  afterEach(async () => { await s.close(); });

  test('未登录 GET /admin/version → 200 登录页', async () => {
    const base = await s.base();
    const r = await fetch(base + '/admin/version');
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('后台登录'));
    assert.ok(!text.includes('保存版本策略'));
  });

  test('未登录 POST /admin/version → 401', async () => {
    const base = await s.base();
    const r = await fetch(base + '/admin/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ latest: '0.3.0' }),
    });
    assert.equal(r.status, 401);
  });

  test('登录后 GET /admin/version 预填当前生效策略', async () => {
    const base = await s.base();
    const { cookie } = await login(base);
    const r = await fetch(base + '/admin/version', { headers: { Cookie: cookie } });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('版本策略'));
    assert.ok(text.includes('保存版本策略'));
    // 预填了默认值 + 强制更新提示
    assert.ok(text.includes(DEFAULT_APP_POLICY.latest));
    assert.ok(text.includes('minSupported'));
    assert.ok(text.includes('强制更新'));
  });

  test('登录后保存成功 → 303 且 app.json 内容确实变了、页面显示新值', async () => {
    const base = await s.base();
    const { cookie } = await login(base);
    const form = new URLSearchParams({
      latest: '0.3.0',
      minSupported: '0.2.5',
      mode: 'link',
      url: 'https://pan.quark.cn/s/newnote',
      notes: '新版本发布说明',
    });
    const r = await fetch(base + '/admin/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: form,
      redirect: 'manual',
    });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location') || '', /\/admin\/version\?msg=/);

    // 读盘确认真的变了
    const cfg = JSON.parse(readFileSync(join(s.config.dataDir, 'app.json'), 'utf8'));
    assert.equal(cfg.latest, '0.3.0');
    assert.equal(cfg.minSupported, '0.2.5');
    assert.equal(cfg.url, 'https://pan.quark.cn/s/newnote');

    // 再 GET /admin/version 看到新内容
    const page = await fetch(base + '/admin/version', { headers: { Cookie: cookie } });
    const text = await page.text();
    assert.ok(text.includes('0.3.0'));
    assert.ok(text.includes('newnote'));
  });

  test('保存后 /v1/app/policy 立即生效（无需重启）', async () => {
    const base = await s.base();
    const { cookie } = await login(base);
    await fetch(base + '/admin/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({
        latest: '0.3.0',
        minSupported: '0.3.0',
        mode: 'direct',
        url: 'https://cdn.example.com/app.exe',
        notes: '',
      }),
      redirect: 'manual',
    });
    const r = await fetch(base + '/v1/app/policy?version=0.2.0');
    const j = await r.json();
    assert.equal(j.data.blocked, true);
    assert.equal(j.data.mode, 'direct');
    assert.equal(j.data.latest, '0.3.0');
  });

  test('保存非法内容（版本号非法）→ 页面显示错误且文件未变、保留输入', async () => {
    const base = await s.base();
    const { cookie } = await login(base);
    const path = join(s.config.dataDir, 'app.json');
    // loadAppPolicy 在缺文件时会写默认文件；这里先触发一次以建立基线
    loadAppPolicy(s.config.dataDir);
    const before = readFileSync(path, 'utf8');

    const form = new URLSearchParams({
      latest: 'abc',
      minSupported: '0.2.5',
      mode: 'link',
      url: 'https://pan.quark.cn/s/x',
      notes: 'x',
    });
    const r = await fetch(base + '/admin/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: form,
      redirect: 'manual',
    });
    const text = await r.text();
    assert.equal(r.status, 200); // 留在同页
    assert.ok(text.includes('版本策略非法')); // 显示错误
    assert.ok(text.includes('abc')); // 保留用户输入
    assert.equal(readFileSync(path, 'utf8'), before); // 文件未变
  });

  test('保存非法内容（url 非 https）→ 页面显示错误且文件未变', async () => {
    const base = await s.base();
    const { cookie } = await login(base);
    const path = join(s.config.dataDir, 'app.json');
    loadAppPolicy(s.config.dataDir); // 建立基线默认文件
    const before = readFileSync(path, 'utf8');

    const r = await fetch(base + '/admin/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({
        latest: '0.3.0',
        minSupported: '0.2.5',
        mode: 'link',
        url: 'http://not-https.com/x',
        notes: '',
      }),
      redirect: 'manual',
    });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('https'));
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test('审计日志含 admin:version 事件', async () => {
    const base = await s.base();
    const { cookie } = await login(base);
    await fetch(base + '/admin/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({
        latest: '0.3.0',
        minSupported: '0.2.5',
        mode: 'link',
        url: 'https://pan.quark.cn/s/x',
        notes: '',
      }),
      redirect: 'manual',
    });
    const audit = readFileSync(s.app.ctx.store._auditPath, 'utf8');
    assert.ok(audit.includes('admin:version'));
  });
});
