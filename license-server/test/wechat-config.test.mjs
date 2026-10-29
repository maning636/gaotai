// wechat-config.mjs 的加载合并与原子保存测试。
//
// 覆盖：
//  - 文件不存在 → 写默认文件并返回默认配置
//  - 旧文件缺 faq/welcome（新增字段）→ 深合并补齐默认值，不丢用户已有字段
//  - 数组整体替换（products 用户自定义时不与默认逐项合并）
//  - 坏 JSON → 降级默认值不抛
//  - 结构非法（products 非数组）→ 降级默认值不抛
//  - saveWechatConfig：正常写入并读回；非法结构被拒且不覆盖原文件
//  - validateWechatConfig 对常见非法结构返回 ok:false

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWechatConfig,
  saveWechatConfig,
  validateWechatConfig,
  DEFAULT_WECHAT_CONFIG,
} from '../lib/wechat-config.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'wxcfg-'));
}

describe('wechat 配置深合并', () => {
  test('文件不存在时写入默认文件并返回默认配置', () => {
    const dir = tempDir();
    const { config, path } = loadWechatConfig(dir);
    assert.equal(config.welcome, DEFAULT_WECHAT_CONFIG.welcome);
    assert.ok(config.faq.length > 0);
    assert.ok(existsSync(path));
    rmSync(dir, { recursive: true, force: true });
  });

  test('旧文件缺 faq/welcome（新增字段）→ 深合并补齐默认值', () => {
    const dir = tempDir();
    // 模拟「旧配置」：只有 fallback 与 listKeywords，没有 faq 与新 welcome
    writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ fallback: '老兜底' }), 'utf8');
    const { config } = loadWechatConfig(dir);
    assert.equal(config.fallback, '老兜底');          // 用户字段保留
    assert.equal(config.welcome, DEFAULT_WECHAT_CONFIG.welcome); // 缺失键补默认
    assert.deepEqual(config.faq, DEFAULT_WECHAT_CONFIG.faq);     // 缺失数组补默认
    assert.deepEqual(config.listKeywords, DEFAULT_WECHAT_CONFIG.listKeywords);
    rmSync(dir, { recursive: true, force: true });
  });

  test('数组整体替换，不与默认逐项合并', () => {
    const dir = tempDir();
    const userProducts = [{ key: 'x', name: 'X', keywords: ['xx'], issue: false, url: '' }];
    writeFileSync(
      join(dir, 'wechat.json'),
      JSON.stringify({ products: userProducts }),
      'utf8',
    );
    const { config } = loadWechatConfig(dir);
    assert.equal(config.products.length, 1);
    assert.equal(config.products[0].key, 'x');
    assert.equal(config.products[0].name, 'X');
    rmSync(dir, { recursive: true, force: true });
  });

  test('menu 对象浅合并', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ menu: { A: 'a' } }), 'utf8');
    const { config } = loadWechatConfig(dir);
    assert.equal(config.menu.A, 'a');
    assert.equal(config.welcome, DEFAULT_WECHAT_CONFIG.welcome);
    rmSync(dir, { recursive: true, force: true });
  });

  test('坏 JSON → 降级到默认值（不抛）', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'wechat.json'), '{ broken json', 'utf8');
    const { config } = loadWechatConfig(dir);
    assert.equal(config.welcome, DEFAULT_WECHAT_CONFIG.welcome);
    assert.deepEqual(config.faq, DEFAULT_WECHAT_CONFIG.faq);
    rmSync(dir, { recursive: true, force: true });
  });

  test('结构非法（products 非数组）→ 降级到默认值（不抛）', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ products: 'not-an-array' }), 'utf8');
    const { config } = loadWechatConfig(dir);
    assert.equal(config.welcome, DEFAULT_WECHAT_CONFIG.welcome);
    assert.ok(Array.isArray(config.products));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('wechat 配置保存（saveWechatConfig）', () => {
  test('正常写入并读回', () => {
    const dir = tempDir();
    const cfg = {
      welcome: '新欢迎语',
      fallback: '新兜底',
      products: [{ key: 'gaotai', name: '稿台', keywords: ['稿台'], issue: true, url: 'u', replySuffix: '' }],
      listKeywords: ['领码'],
      faq: [{ keywords: ['怎么用'], reply: '步骤一\n步骤二' }],
      menu: {},
    };
    const r = saveWechatConfig(dir, cfg);
    assert.equal(r.ok, true);
    const onDisk = JSON.parse(readFileSync(join(dir, 'wechat.json'), 'utf8'));
    assert.equal(onDisk.welcome, '新欢迎语');
    assert.equal(onDisk.faq[0].reply, '步骤一\n步骤二');
    // 读回：字段齐全
    const { config } = loadWechatConfig(dir);
    assert.equal(config.welcome, '新欢迎语');
    assert.deepEqual(config.faq, cfg.faq);
    rmSync(dir, { recursive: true, force: true });
  });

  test('非法结构被拒且不覆盖原文件', () => {
    const dir = tempDir();
    const original = { welcome: '原', fallback: '兜', products: [], faq: [], listKeywords: [], menu: {} };
    const r0 = saveWechatConfig(dir, original);
    assert.equal(r0.ok, true);
    const before = readFileSync(join(dir, 'wechat.json'), 'utf8');

    // 非法：products 不是数组
    const bad = { ...original, products: 'oops' };
    const r = saveWechatConfig(dir, bad);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('products'));
    // 原文件未被覆盖
    const after = readFileSync(join(dir, 'wechat.json'), 'utf8');
    assert.equal(after, before);
    rmSync(dir, { recursive: true, force: true });
  });

  test('validateWechatConfig 对常见非法结构返回 ok:false', () => {
    assert.equal(validateWechatConfig(null).ok, false);
    assert.equal(validateWechatConfig({}).ok, false); // 缺必填字段
    assert.equal(
      validateWechatConfig({ ...DEFAULT_WECHAT_CONFIG, products: [{ key: '', name: '', keywords: [], issue: true }] }).ok,
      false,
    );
    assert.equal(
      validateWechatConfig({ ...DEFAULT_WECHAT_CONFIG, faq: [{ keywords: [], reply: 5 }] }).ok,
      false,
    );
    assert.equal(validateWechatConfig({ ...DEFAULT_WECHAT_CONFIG, listKeywords: 'x' }).ok, false);
    assert.equal(validateWechatConfig({ ...DEFAULT_WECHAT_CONFIG, menu: [] }).ok, false);
    assert.equal(validateWechatConfig(DEFAULT_WECHAT_CONFIG).ok, true);
  });
});
