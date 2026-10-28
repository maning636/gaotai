import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSetup, issueCodeDirect, fakeMachine } from './helpers.mjs';
import {
  normalizeCode,
  generateCode,
  createStore,
  DEFAULT_CODE_FORMAT,
} from '../lib/store.mjs';
import { parseCodeFormat, validateCodeFormat, parseConfig, selfCheck } from '../lib/config.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 自定义格式：prefix=FDE, body=12, group=3
const FDE = { prefix: 'FDE', bodyLength: 12, groupSize: 3, alphabet: DEFAULT_CODE_FORMAT.alphabet };
// 无前缀、不分段
const NOPREFIX = { prefix: '', bodyLength: 12, groupSize: 0, alphabet: DEFAULT_CODE_FORMAT.alphabet };
// 无前缀、分组
const NOPREFIX_GROUP = { prefix: '', bodyLength: 12, groupSize: 4, alphabet: DEFAULT_CODE_FORMAT.alphabet };

// 默认格式下生成/规范化行为与现在完全一致（回归）
describe('默认格式回归', () => {
  test('normalizeCode 输出 GT-XXXX-XXXX-XXXX-XXXX', () => {
    assert.equal(normalizeCode('GT-7F3K-9QW2-M4XB-8HZP'), 'GT-7F3K-9QW2-M4XB-8HZP');
    assert.equal(normalizeCode('gt-7f3k-9qw2-m4xb-8hzp'), 'GT-7F3K-9QW2-M4XB-8HZP');
    assert.equal(normalizeCode(' 7f3k9qw2m4xb8hzp '), 'GT-7F3K-9QW2-M4XB-8HZP');
    assert.equal(normalizeCode('7F3K9QW2M4XB8HZP'), 'GT-7F3K-9QW2-M4XB-8HZP');
    // 非法
    assert.equal(normalizeCode('GT-1234'), '');
    assert.equal(normalizeCode(''), '');
    assert.equal(normalizeCode(null), '');
  });

  test('generateCode 默认格式下碰撞重试仍可用', () => {
    // 用固定 randomInt 序列模拟，验证格式为 GT-XXXX-XXXX-XXXX-XXXX
    const store = { findCode: () => false };
    const seq = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    let i = 0;
    const ri = () => seq[i++ % seq.length];
    const code = generateCode(store, ri);
    assert.match(code, /^GT-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
  });
});

// 自定义格式：能生成、能规范化、能激活
describe('自定义格式 FDE/12/3', () => {
  let s;
  beforeEach(async () => { s = makeSetup({ codeFormat: { ...FDE } }); });
  afterEach(async () => { await s.close(); });

  test('normalizeCode 用自定义格式', () => {
    // 带前缀 12 位 3 分组
    const code = normalizeCode('FDE-ABC-DEF-123-456', FDE);
    assert.equal(code, 'FDE-ABC-DEF-123-456');
    // 漏前缀 / 小写 / 空格都能补
    assert.equal(normalizeCode(' abcdef123456 ', FDE), 'FDE-ABC-DEF-123-456');
    assert.equal(normalizeCode('fde-abc-def-123-456', FDE), 'FDE-ABC-DEF-123-456');
  });

  test('发码 → 激活成功', async () => {
    const code = await issueCodeDirect(s, 'fde_alice');
    assert.ok(code.startsWith('FDE-'));
    assert.equal(code.split('-').length, 5); // FDE + 4 组 3 位
    const base = await s.base();
    const r = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: fakeMachine('fde-pc') }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.data.code, code);
  });

  test('用户输入漏前缀/小写/带空格 → 仍能激活', async () => {
    const code = await issueCodeDirect(s, 'fde_bob');
    const body = code.replace('FDE-', '').toLowerCase() + '  ';
    const base = await s.base();
    const r = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: body, machine: fakeMachine('fde-bob-pc') }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.data.code, code);
  });
});

// groupSize=0 时不插连字符
describe('groupSize=0', () => {
  test('normalizeCode 不插连字符', () => {
    // 用不含 I/L/O 的 Crockford 字符，避免被映射
    assert.equal(normalizeCode('ABCDEFGHJKMN', NOPREFIX), 'ABCDEFGHJKMN');
    assert.equal(normalizeCode('abc def ghj kmn', NOPREFIX), 'ABCDEFGHJKMN');
  });

  test('generateCode 不插连字符', () => {
    const store = { findCode: () => false };
    const ri = () => 0;
    const code = generateCode(store, ri, NOPREFIX);
    assert.equal(code.length, 12);
    assert.ok(!code.includes('-'));
  });

  test('能激活', async () => {
    const s = makeSetup({ codeFormat: { ...NOPREFIX } });
    const code = await issueCodeDirect(s, 'np_alice');
    assert.ok(!code.includes('-'));
    const base = await s.base();
    const r = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machine: fakeMachine('np-pc') }),
    });
    assert.equal(r.status, 200);
    await s.close();
  });
});

// 前缀为空时码体直接分组
describe('prefix 为空', () => {
  test('码体直接分组', () => {
    // 用不含 I/L/O 的 Crockford 字符，避免被映射
    assert.equal(normalizeCode('ABCD-EFGH-JKMN', NOPREFIX_GROUP), 'ABCD-EFGH-JKMN');
    assert.equal(normalizeCode('abcd efgh jkmn', NOPREFIX_GROUP), 'ABCD-EFGH-JKMN');
  });
});

// 旧格式码在新格式实例里（模拟「切换过格式」）→ 按兼容逻辑仍可激活
describe('旧格式兼容', () => {
  test('默认格式码在自定义实例中仍可激活', async () => {
    // 先用默认格式实例发一个码（写入默认格式的库）
    const old = makeSetup({ codeFormat: { ...DEFAULT_CODE_FORMAT } });
    const oldCode = await issueCodeDirect(old, 'legacy_user');
    assert.ok(oldCode.startsWith('GT-'));
    await old.close();

    // 切到自定义格式实例（同样的 dataDir 会保留旧码，这里重新建实例共享同一 dataDir 模拟切换）
    // 用同一 dataDir 的第二个实例来模拟「格式已切换」：直接构造 store 测试兼容逻辑
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-compat-'));
    const storeA = createStore({ dataDir, codeFormat: { ...DEFAULT_CODE_FORMAT } });
    await storeA.issueCode({ code: oldCode, contact: 'legacy_user', channel: 'direct' });

    // 切换到自定义格式的 store（同一 dataDir）
    const storeB = createStore({ dataDir, codeFormat: { ...FDE } });
    const res = storeB.resolveCode(oldCode);
    assert.ok(res.record, '旧格式码在自定义格式实例中应可解析');
    assert.equal(res.code, oldCode);
    assert.equal(res.record.code, oldCode);
  });

  test('HTTP 层：默认格式码在自定义实例可激活', async () => {
    // 先用默认格式发码
    const old = makeSetup({ codeFormat: { ...DEFAULT_CODE_FORMAT } });
    const oldCode = await issueCodeDirect(old, 'legacy_http');
    await old.close();

    // 新实例用自定义格式，但手动把旧码写进它的库
    const s = makeSetup({ codeFormat: { ...FDE } });
    await s.app.ctx.store.issueCode({ code: oldCode, contact: 'legacy_http', channel: 'direct' });
    const base = await s.base();
    const r = await fetch(base + '/v1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: oldCode, machine: fakeMachine('legacy-pc') }),
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.data.code, oldCode);
    await s.close();
  });
});

// 配置解析与校验
describe('config 解析与校验', () => {
  test('默认值保持 GT/16/4/Crockford', () => {
    const f = parseCodeFormat({});
    assert.equal(f.prefix, 'GT');
    assert.equal(f.bodyLength, 16);
    assert.equal(f.groupSize, 4);
    assert.equal(f.alphabet, DEFAULT_CODE_FORMAT.alphabet);
    const v = validateCodeFormat(f);
    assert.equal(v.ok, true);
  });

  test('自定义环境变量解析', () => {
    const f = parseCodeFormat({ CODE_PREFIX: 'FDE', CODE_BODY_LENGTH: '12', CODE_GROUP_SIZE: '3' });
    assert.equal(f.prefix, 'FDE');
    assert.equal(f.bodyLength, 12);
    assert.equal(f.groupSize, 3);
  });

  test('非法配置：长度不可整除', () => {
    const v = validateCodeFormat({ prefix: 'GT', bodyLength: 16, groupSize: 3, alphabet: DEFAULT_CODE_FORMAT.alphabet });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('整除')));
  });

  test('非法配置：字符集太小', () => {
    const v = validateCodeFormat({ prefix: 'GT', bodyLength: 16, groupSize: 4, alphabet: '0123456789' });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('CODE_ALPHABET')));
  });

  test('非法配置：前缀非法', () => {
    const v = validateCodeFormat({ prefix: 'GT-', bodyLength: 16, groupSize: 4, alphabet: DEFAULT_CODE_FORMAT.alphabet });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('CODE_PREFIX')));
  });

  test('非法配置：熵不足', () => {
    // 2 字符 ^ 6 位 = 64，远小于 1e12
    const v = validateCodeFormat({ prefix: 'GT', bodyLength: 6, groupSize: 6, alphabet: 'AB' });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('1e12')));
  });

  test('parseConfig 挂载 codeFormat 且自检通过', () => {
    const cfg = parseConfig({ CODE_PREFIX: 'FDE', CODE_BODY_LENGTH: '12', CODE_GROUP_SIZE: '3' }, {
      privateKey: 'fake-pem-PRIVATE KEY',
      publicKey: 'pub',
    });
    assert.equal(cfg.codeFormat.prefix, 'FDE');
    // 临时 data 目录注入避免读真实目录
    cfg.dataDir = mkdtempSync(join(tmpdir(), 'ls-cfg-'));
    const check = selfCheck(cfg);
    assert.equal(check.ok, true);
  });

  test('parseConfig 非法格式 → 自检失败有中文错误', () => {
    const cfg = parseConfig({ CODE_BODY_LENGTH: '16', CODE_GROUP_SIZE: '3' }, {
      privateKey: 'fake-pem-PRIVATE KEY',
      publicKey: 'pub',
    });
    cfg.dataDir = mkdtempSync(join(tmpdir(), 'ls-cfg-'));
    const check = selfCheck(cfg);
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((e) => e.includes('注册码格式配置非法')));
  });
});

// CLI show-format
describe('CLI show-format', () => {
  test('打印默认格式', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['scripts/license-cli.mjs', 'show-format'], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('GT'));
  });
});
