import { generateKeyPairSync, randomInt } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { derivePublicKeyPem, verifyToken, decryptAsset, deriveAssetKey } from '../lib/token.mjs';
import { DEFAULT_CODE_FORMAT } from '../lib/store.mjs';

// 每个测试用例拿到独立的临时目录、临时密钥、独立限流器
// 避免用例之间共享状态导致 IP 计数器互相污染
export function makeSetup(opts = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const dataDir = mkdtempSync(join(tmpdir(), 'ls-test-'));
  const assetsDir = mkdtempSync(join(tmpdir(), 'ls-assets-'));

  const config = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    privateKeyPath: dataDir + '/fake.pem',
    assetsDir,
    trustProxy: false,
    tokenTtlDays: 30,
    tokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    rateFails: 5,
    rateWindowMs: 5 * 60 * 1000,
    redeemPerHour: 20,
    redeemChannels: ['wechat-mp', 'wechat-oa', 'direct'],
    // 注册码格式：默认保持不变，可传 opts.codeFormat 覆盖
    codeFormat: opts.codeFormat || { ...DEFAULT_CODE_FORMAT },
    privateKey: privPem,
    publicKey: pubPem,
    randomInt: opts.randomInt || randomInt,
  };

  const app = createApp({ config });

  const server = createServer((req, res) => app.handler(req, res));
  const started = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  async function port() {
    return await started;
  }
  async function base() {
    return 'http://127.0.0.1:' + (await port());
  }

  // 造一个最小资产包用于测试
  function seedAsset(name, version, files) {
    const pack = { version, files };
    const packJson = JSON.stringify(pack);
    writeFileSync(join(assetsDir, name + '.json'), packJson);
    const sha = createHash('sha256').update(Buffer.from(packJson, 'utf8')).digest('hex');
    return { name, version, bytes: Buffer.byteLength(packJson), sha256: sha, url: `/v1/assets/${name}?version=${version}` };
  }
  function seedManifest(version, assets) {
    writeFileSync(join(assetsDir, 'manifest.json'), JSON.stringify({ version, assets }));
  }

  async function close() {
    app.close();
    await new Promise((r) => server.close(r));
  }

  return {
    config,
    app,
    server,
    port,
    base,
    privPem,
    pubPem,
    seedAsset,
    seedManifest,
    close,
  };
}

// 便捷：直接发码并返回 code（经 store 层，不经 HTTP）
export async function issueCodeDirect(setup, contact = 'wx_test', extra = {}) {
  const { generateCode } = await import('../lib/store.mjs');
  const code = generateCode(setup.app.ctx.store, setup.config.randomInt, setup.config.codeFormat);
  const record = await setup.app.ctx.store.issueCode({
    code,
    contact,
    channel: 'direct',
    ...extra,
  });
  return record.code;
}

// 造一个合法的 64 位 hex 机器码
export function fakeMachine(seed = 'a') {
  return createHash('sha256').update(seed).digest('hex');
}

export { derivePublicKeyPem, verifyToken, decryptAsset, deriveAssetKey };
