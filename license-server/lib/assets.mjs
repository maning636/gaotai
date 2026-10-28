import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deriveAssetKey, encryptAsset } from './token.mjs';

// 资产管理：读 assets/packs/<name>.json 与 manifest.json
// manifest 由 bundle-assets 脚本生成，记录每个包的 version/sha256/bytes
// 运行时只读不写，assets 目录可视为只挂载的产物

export function createAssets({ assetsDir }) {
  const manifestPath = resolve(assetsDir, 'manifest.json');

  function readManifest() {
    if (!existsSync(manifestPath)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      return null;
    }
  }

  // 读取某个资产包的明文 JSON（bundle-assets 产出的就是明文包结构）
  // 明文结构：{ version, files: { "path": "<base64 内容>" } }
  function readPack(name) {
    const packPath = resolve(assetsDir, name + '.json');
    if (!existsSync(packPath)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(packPath, 'utf8'));
    } catch {
      return null;
    }
  }

  // manifest 里的 sha256 是明文包的字节级 sha256，用于客户端解密后校验
  function plainSha256(packObj) {
    const plain = Buffer.from(JSON.stringify(packObj), 'utf8');
    return createHash('sha256').update(plain).digest('hex');
  }

  function plainBytes(packObj) {
    return Buffer.byteLength(JSON.stringify(packObj), 'utf8');
  }

  // GET /v1/assets/manifest 的数据
  // 协议 §4.4：需 Authorization 校验（由路由层做），这里只出数据
  function manifestData() {
    const m = readManifest();
    if (!m) return null;
    return {
      version: m.version,
      assets: (m.assets || []).map((a) => ({
        name: a.name,
        version: a.version,
        bytes: a.bytes,
        sha256: a.sha256,
        url: `/v1/assets/${a.name}?version=${a.version}`,
      })),
    };
  }

  // GET /v1/assets/:name 的数据
  // 协议 §5：密钥从 token 派生，AES-256-GCM，返回 { iv, tag, data } base64
  // version 必须匹配 manifest，否则视为不存在（404）
  function encryptedAsset(name, version, tokenStr) {
    const m = readManifest();
    if (!m) return { error: 'not_found' };

    const entry = (m.assets || []).find(
      (a) => a.name === name && a.version === version
    );
    if (!entry) return { error: 'not_found' };

    const pack = readPack(name);
    if (!pack) return { error: 'not_found' };

    // manifest 的 sha256 是明文包的摘要，这里复算一遍用于 plainSha256 字段
    const plainBuf = Buffer.from(JSON.stringify(pack), 'utf8');
    const sha = createHash('sha256').update(plainBuf).digest('hex');

    const key = deriveAssetKey(tokenStr, name, version);
    const enc = encryptAsset(key, plainBuf);

    return {
      ok: true,
      data: {
        name,
        version,
        plainSha256: sha,
        iv: enc.iv,
        tag: enc.tag,
        data: enc.data,
      },
    };
  }

  return {
    readManifest,
    readPack,
    manifestData,
    encryptedAsset,
    plainSha256,
    plainBytes,
    _assetsDir: assetsDir,
  };
}
