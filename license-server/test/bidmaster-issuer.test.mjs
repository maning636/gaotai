// bidmaster-issuer 单测：注入假 fetch，不打真实网络。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBidmasterIssuer } from '../lib/bidmaster-issuer.mjs';

function fakeBidmaster({ failCreateOnce = false, failLoginOnce = false } = {}) {
  const calls = { login: 0, create: 0 };
  const createdCodes = [];
  let createFailNext = failCreateOnce;
  let loginFailNext = failLoginOnce;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).endsWith('/api/auth/login')) {
      calls.login += 1;
      if (loginFailNext) {
        loginFailNext = false;
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ token: 'tok-' + calls.login }) };
    }
    if (String(url).endsWith('/api/admin/licenses')) {
      calls.create += 1;
      if (createFailNext) {
        createFailNext = false;
        return { ok: false, status: 500, text: async () => 'boom' };
      }
      const body = JSON.parse(opts.body);
      const code = `TEST-${String(calls.create).padStart(4, '0')}`;
      createdCodes.push({ code, customer: body.customer, valid_days: body.valid_days });
      return { ok: true, status: 201, json: async () => ({ license: { code } }) };
    }
    throw new Error('unexpected url ' + url);
  };
  return { fetchImpl, calls, createdCodes };
}

describe('bidmaster-issuer', () => {
  const baseEnv = {
    BIDMASTER_API_URL: 'http://127.0.0.1:8093',
    BIDMASTER_ADMIN_USER: 'license-bot',
    BIDMASTER_ADMIN_PASS: 'secret',
  };

  test('发码：登录→建码→返回码，validityDays 透传', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-issuer-'));
    try {
      const fake = fakeBidmaster();
      const issuer = createBidmasterIssuer({ dataDir: dir, env: baseEnv, fetchImpl: fake.fetchImpl });
      const code = await issuer.issueForOpenid('openid-A', { key: 'bidmaster', validityDays: 15 });
      assert.match(code, /^TEST-/);
      assert.equal(fake.calls.login, 1);
      assert.equal(fake.calls.create, 1);
      assert.equal(fake.createdCodes[0].customer, 'wechat-oa:openid-A');
      assert.equal(fake.createdCodes[0].valid_days, 15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('幂等：同一 openid 二次发码返回同码，不再调建码接口', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-issuer-'));
    try {
      const fake = fakeBidmaster();
      const issuer = createBidmasterIssuer({ dataDir: dir, env: baseEnv, fetchImpl: fake.fetchImpl });
      const c1 = await issuer.issueForOpenid('openid-A', { key: 'bidmaster' });
      const c2 = await issuer.issueForOpenid('openid-A', { key: 'bidmaster' });
      assert.equal(c1, c2);
      assert.equal(fake.calls.create, 1);
      // 不同 openid 各自发码
      const c3 = await issuer.issueForOpenid('openid-B', { key: 'bidmaster' });
      assert.notEqual(c1, c3);
      assert.equal(fake.calls.create, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('建码失败 500 → 抛错（路由层降级提示）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-issuer-'));
    try {
      const fake = fakeBidmaster({ failCreateOnce: true });
      const issuer = createBidmasterIssuer({ dataDir: dir, env: baseEnv, fetchImpl: fake.fetchImpl });
      await assert.rejects(() => issuer.issueForOpenid('openid-C', {}));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('登录 401 → 重登一次后成功', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-issuer-'));
    try {
      const fake = fakeBidmaster({ failLoginOnce: true });
      const issuer = createBidmasterIssuer({ dataDir: dir, env: baseEnv, fetchImpl: fake.fetchImpl });
      const code = await issuer.issueForOpenid('openid-D', {});
      assert.match(code, /^TEST-/);
      assert.equal(fake.calls.login, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('未配置凭据 → 抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bm-issuer-'));
    try {
      const fake = fakeBidmaster();
      const issuer = createBidmasterIssuer({ dataDir: dir, env: {}, fetchImpl: fake.fetchImpl });
      await assert.rejects(() => issuer.issueForOpenid('openid-E', {}));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
