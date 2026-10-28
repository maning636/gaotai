import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSetup } from './helpers.mjs';
import { checkSignature, parseXml, textReplyXml, signatureOf } from '../lib/wechat.mjs';
import { handleWechatMessage } from '../lib/wechat-router.mjs';
import { loadWechatConfig, DEFAULT_WECHAT_CONFIG } from '../lib/wechat-config.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'testtoken';

// 构造一个带签名参数的真实回调 URL 前缀
function wechatUrl(base, extra = {}) {
  const timestamp = String(extra.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = extra.nonce ?? 'abc123';
  const signature = signatureOf({ token: TOKEN, timestamp, nonce });
  const qs = new URLSearchParams({ signature, timestamp, nonce, ...extra });
  return base + '/wechat?' + qs.toString();
}

// 生成微信风格的文本消息 XML（带 CDATA）
function textMsgXml({ from = 'openid_test', content, msgId = '123456' }) {
  return (
    '<xml>' +
    `<ToUserName><![CDATA[gh_test]]></ToUserName>` +
    `<FromUserName><![CDATA[${from}]]></FromUserName>` +
    '<CreateTime>1700000000</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${content}]]></Content>` +
    `<MsgId>${msgId}</MsgId>` +
    '</xml>'
  );
}

// 关注/取关事件 XML
function eventMsgXml({ from = 'openid_test', event = 'subscribe', eventKey } = {}) {
  return (
    '<xml>' +
    `<ToUserName><![CDATA[gh_test]]></ToUserName>` +
    `<FromUserName><![CDATA[${from}]]></FromUserName>` +
    '<CreateTime>1700000000</CreateTime>' +
    '<MsgType><![CDATA[event]]></MsgType>' +
    `<Event><![CDATA[${event}]]></Event>` +
    (eventKey ? `<EventKey><![CDATA[${eventKey}]]></EventKey>` : '') +
    '</xml>'
  );
}

describe('微信签名', () => {
  test('正确签名通过', () => {
    const ts = '1700000000';
    const nonce = 'nonce123';
    const sig = signatureOf({ token: TOKEN, timestamp: ts, nonce });
    assert.equal(checkSignature({ token: TOKEN, signature: sig, timestamp: ts, nonce }), true);
  });

  test('错误签名不通过', () => {
    const ts = '1700000000';
    const nonce = 'nonce123';
    assert.equal(checkSignature({ token: TOKEN, signature: 'deadbeef', timestamp: ts, nonce }), false);
  });

  test('缺参数不通过', () => {
    const ts = '1700000000';
    const sig = signatureOf({ token: TOKEN, timestamp: ts, nonce: 'x' });
    assert.equal(checkSignature({ token: TOKEN, signature: sig, timestamp: ts }), false);
    assert.equal(checkSignature({ token: TOKEN, signature: sig, nonce: 'x' }), false);
    assert.equal(checkSignature({ signature: sig, timestamp: ts, nonce: 'x' }), false);
  });
});

describe('XML 解析', () => {
  test('CDATA 与实体转义都被正确解析', () => {
    const xml =
      '<xml>' +
      '<ToUserName><![CDATA[gh_x]]></ToUserName>' +
      '<FromUserName><![CDATA[o_1]]></FromUserName>' +
      '<CreateTime>1700000000</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[a &lt;b&gt; c]]></Content>' +
      '<MsgId>999</MsgId>' +
      '</xml>';
    const m = parseXml(xml);
    assert.equal(m.ToUserName, 'gh_x');
    assert.equal(m.FromUserName, 'o_1');
    assert.equal(m.MsgType, 'text');
    assert.equal(m.MsgId, '999');
    // CDATA 内容原样取出，不解析实体
    assert.equal(m.Content, 'a &lt;b&gt; c');
  });

  test('纯文本字段做实体解码', () => {
    const m = parseXml('<xml><Content>a &amp; b &lt;tag&gt;</Content></xml>');
    assert.equal(m.Content, 'a & b <tag>');
  });

  test('内容里含 ]]> 时 CDATA 断开仍能解析出原文', () => {
    const xml =
      '<xml><Content><![CDATA[a]]]]><![CDATA[>b]]></Content></xml>';
    const m = parseXml(xml);
    // 断开后解析器应还原为 a]]>b
    assert.equal(m.Content, 'a]]>b');
  });
});

describe('被动回复 XML', () => {
  test('生成 text 回复，字段顺序与 CDATA 正确', () => {
    const xml = textReplyXml({ toUser: 'o_abc', fromUser: 'gh_x', content: '你好', now: 1700000000000 });
    assert.ok(xml.startsWith('<xml>'));
    assert.ok(xml.includes('<ToUserName><![CDATA[o_abc]]></ToUserName>'));
    assert.ok(xml.includes('<FromUserName><![CDATA[gh_x]]></FromUserName>'));
    assert.ok(xml.includes('<CreateTime>1700000000</CreateTime>'));
    assert.ok(xml.includes('<MsgType><![CDATA[text]]></MsgType>'));
    assert.ok(xml.includes('<Content><![CDATA[你好]]></Content>'));
  });

  test('内容含 ]]> 时安全断开', () => {
    const xml = textReplyXml({ toUser: 'o', fromUser: 'g', content: 'a]]>b', now: 0 });
    assert.ok(xml.includes('a]]]]><![CDATA[>b'));
  });
});

describe('消息路由（纯逻辑）', () => {
  const baseConfig = {
    ...DEFAULT_WECHAT_CONFIG,
    products: [{ key: 'gaotai', name: '稿台', keywords: ['稿台', '写作'], issue: true, url: 'u', replySuffix: '后缀' }],
  };

  test('关注事件 → 欢迎语 + 产品清单', async () => {
    const r = await handleWechatMessage({ message: { MsgType: 'event', Event: 'subscribe' }, config: baseConfig, openid: 'o' });
    assert.ok(r.reply.includes('谢谢你关注'));
    assert.ok(r.reply.includes('稿台'));
  });

  test('取关事件 → reply null', async () => {
    const r = await handleWechatMessage({ message: { MsgType: 'event', Event: 'unsubscribe' }, config: baseConfig, openid: 'o' });
    assert.equal(r.reply, null);
  });

  test('发「稿台」→ 触发 issue 回调并返回码', async () => {
    let called = null;
    const r = await handleWechatMessage({
      message: { MsgType: 'text', Content: '稿台' },
      config: baseConfig,
      openid: 'o1',
      issue: (oid, product) => {
        called = { oid, key: product.key };
        return 'GT-AAAA-BBBB-CCCC-DDDD';
      },
    });
    assert.deepEqual(called, { oid: 'o1', key: 'gaotai' });
    assert.ok(r.reply.includes('GT-AAAA-BBBB-CCCC-DDDD'));
    assert.ok(r.reply.includes('后缀'));
  });

  test('发「领码」→ 返回产品清单', async () => {
    const r = await handleWechatMessage({ message: { MsgType: 'text', Content: '领码' }, config: baseConfig, openid: 'o' });
    assert.ok(r.reply.includes('现有产品'));
    assert.ok(r.reply.includes('稿台'));
  });

  test('发无关内容 → 兜底语', async () => {
    const r = await handleWechatMessage({ message: { MsgType: 'text', Content: '随便说说' }, config: baseConfig, openid: 'o' });
    assert.equal(r.reply, baseConfig.fallback);
  });

  test('CLICK 事件按 menu 配置回话，未配置用兜底', async () => {
    const cfg = { ...baseConfig, menu: { HELP: '这是帮助' } };
    const ok = await handleWechatMessage({ message: { MsgType: 'event', Event: 'CLICK', EventKey: 'HELP' }, config: cfg, openid: 'o' });
    assert.equal(ok.reply, '这是帮助');
    const miss = await handleWechatMessage({ message: { MsgType: 'event', Event: 'CLICK', EventKey: 'NOPE' }, config: cfg, openid: 'o' });
    assert.equal(miss.reply, cfg.fallback);
  });

  test('最长关键词优先', async () => {
    const cfg = {
      ...baseConfig,
      products: [
        { key: 'a', name: 'A', keywords: ['稿'], issue: true },
        { key: 'b', name: 'B', keywords: ['稿台'], issue: true },
      ],
    };
    let got = null;
    await handleWechatMessage({
      message: { MsgType: 'text', Content: '我要稿台' },
      config: cfg,
      openid: 'o',
      issue: async (oid, p) => { got = p.key; return 'X'; },
    });
    assert.equal(got, 'b');
  });
});

describe('微信配置加载', () => {
  test('文件不存在时写入默认文件并返回默认配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxcfg-'));
    const { config, path } = loadWechatConfig(dir);
    assert.equal(config.welcome, DEFAULT_WECHAT_CONFIG.welcome);
    assert.ok(existsSync(path));
    rmSync(dir, { recursive: true, force: true });
  });

  test('读取失败降级到默认值（不抛）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxcfg-'));
    writeFileSync(join(dir, 'wechat.json'), '{ broken json', 'utf8');
    const { config } = loadWechatConfig(dir);
    assert.equal(config.welcome, DEFAULT_WECHAT_CONFIG.welcome);
    rmSync(dir, { recursive: true, force: true });
  });

  test('用户配置覆盖默认字段（menu 合并）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxcfg-'));
    writeFileSync(
      join(dir, 'wechat.json'),
      JSON.stringify({ fallback: '自定义兜底', menu: { A: 'a' } }),
      'utf8',
    );
    const { config } = loadWechatConfig(dir);
    assert.equal(config.fallback, '自定义兜底');
    assert.equal(config.menu.A, 'a');
    assert.equal(config.welcome, DEFAULT_WECHAT_CONFIG.welcome);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('微信回调 HTTP', () => {
  let s;
  beforeEach(async () => {
    s = makeSetup();
    s.config.wechatToken = TOKEN;
    s.config.wechatOriginalId = 'gh_test';
    s.config.wechat = { ...DEFAULT_WECHAT_CONFIG };
  });
  afterEach(async () => { await s.close(); });

  test('GET 验签通过回显 echostr', async () => {
    const base = await s.base();
    const ts = '1700000000';
    const nonce = 'n1';
    const sig = signatureOf({ token: TOKEN, timestamp: ts, nonce });
    const r = await fetch(`${base}/wechat?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=hello_echo`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'hello_echo');
  });

  test('GET 错误签名 → 403', async () => {
    const base = await s.base();
    const r = await fetch(`${base}/wechat?signature=bad&timestamp=1&nonce=2&echostr=x`);
    assert.equal(r.status, 403);
  });

  test('GET 缺参数 → 403', async () => {
    const base = await s.base();
    const r = await fetch(`${base}/wechat?signature=bad`);
    assert.equal(r.status, 403);
  });

  test('未配置 WECHAT_TOKEN → 403', async () => {
    s.config.wechatToken = '';
    const base = await s.base();
    const ts = '1700000000';
    const nonce = 'n1';
    const sig = signatureOf({ token: TOKEN, timestamp: ts, nonce });
    const r = await fetch(`${base}/wechat?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=x`);
    assert.equal(r.status, 403);
  });

  test('关注事件 → 返回欢迎语 XML', async () => {
    const base = await s.base();
    const url = wechatUrl(base);
    const r = await fetch(url, { method: 'POST', body: eventMsgXml({ event: 'subscribe' }) });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.startsWith('<xml>'));
    assert.ok(text.includes('谢谢你关注'));
    assert.ok(text.includes('稿台'));
  });

  test('发「稿台」→ 返回 GT- 码；同 openid 再发 → 同一码（幂等）', async () => {
    const base = await s.base();
    const url = wechatUrl(base);
    const r1 = await fetch(url, { method: 'POST', body: textMsgXml({ content: '稿台', msgId: '1001' }) });
    const t1 = await r1.text();
    assert.ok(t1.includes('GT-'));
    const code1 = t1.match(/GT-[A-Z0-9-]+/)[0];

    // 同 openid、不同 MsgId（用户又发了一次）→ store contact 幂等返回原码
    const r2 = await fetch(url, { method: 'POST', body: textMsgXml({ content: '稿台', msgId: '1002' }) });
    const t2 = await r2.text();
    const code2 = t2.match(/GT-[A-Z0-9-]+/)[0];
    assert.equal(code1, code2);
  });

  test('重复推送同一 MsgId → 第二次返回空串', async () => {
    const base = await s.base();
    const url = wechatUrl(base);
    const body = textMsgXml({ content: '稿台', msgId: '777' });
    const r1 = await fetch(url, { method: 'POST', body });
    assert.ok((await r1.text()).includes('GT-'));

    const r2 = await fetch(url, { method: 'POST', body });
    assert.equal(r2.status, 200);
    assert.equal(await r2.text(), '');
  });

  test('发「领码」→ 返回产品清单', async () => {
    const base = await s.base();
    const url = wechatUrl(base);
    const r = await fetch(url, { method: 'POST', body: textMsgXml({ content: '领码', msgId: '2001' }) });
    const text = await r.text();
    assert.ok(text.includes('现有产品'));
    assert.ok(text.includes('稿台'));
  });

  test('发「随便说说」→ 返回兜底语', async () => {
    const base = await s.base();
    const url = wechatUrl(base);
    const r = await fetch(url, { method: 'POST', body: textMsgXml({ content: '随便说说', msgId: '2002' }) });
    const text = await r.text();
    assert.ok(text.includes(DEFAULT_WECHAT_CONFIG.fallback));
  });

  test('取关事件 → 200 且空 body', async () => {
    const base = await s.base();
    const url = wechatUrl(base);
    const r = await fetch(url, { method: 'POST', body: eventMsgXml({ event: 'unsubscribe' }) });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '');
  });

  test('XML 含 CDATA 与实体转义时不崩', async () => {
    const base = await s.base();
    const url = wechatUrl(base);
    const body =
      '<xml><ToUserName><![CDATA[gh_x]]></ToUserName><FromUserName><![CDATA[o_z]]></FromUserName>' +
      '<CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[稿台 &amp; 测试]]></Content><MsgId>3001</MsgId></xml>';
    const r = await fetch(url, { method: 'POST', body });
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('GT-'));
  });
});
