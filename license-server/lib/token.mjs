import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { hkdfSync, createCipheriv, createDecipheriv, randomFillSync } from 'node:crypto';

// 协议 §3：token 前缀固定
const TOKEN_PREFIX = 'gt1.';
// 协议 §5：HKDF 盐固定
const ASSET_SALT = 'gaotai-asset-v1';

// base64url 编解码（无依赖）
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

// 协议 §3：gt1.<base64url(payloadJSON)>.<base64url(signature)>
// 签名内容是 "gt1." + base64url(payloadJSON)，即前缀加 payload，不含 signature 段
export function signToken(privateKeyPem, payload) {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadJson);
  const signingInput = TOKEN_PREFIX + payloadB64;

  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(signingInput, 'utf8'), key);

  return TOKEN_PREFIX + payloadB64 + '.' + b64urlEncode(sig);
}

// 只验签名与结构，不校验 machine/expiresAt——那是调用方的职责
// 返回 { ok, payload } 或 { ok:false, reason }
export function verifyToken(publicKeyPem, token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, reason: 'format' };
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot < 0) {
    return { ok: false, reason: 'format' };
  }
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'payload' };
  }

  // 协议 §3：签名内容是 "gt1." + base64url(payloadJSON)
  const signingInput = TOKEN_PREFIX + payloadB64;
  let sigBuf;
  try {
    sigBuf = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'signature' };
  }

  const key = createPublicKey(publicKeyPem);
  const valid = verify(null, Buffer.from(signingInput, 'utf8'), key, sigBuf);
  if (!valid) {
    return { ok: false, reason: 'signature' };
  }
  return { ok: true, payload };
}

// 协议 §5：token 过期即取不到资产，这里给调用方判断 expiresAt 的工具
export function isTokenExpired(payload, now = Date.now()) {
  return typeof payload.expiresAt === 'number' && payload.expiresAt <= now;
}

// 协议 §5：从 token 字符串派生资产密钥
// hkdfSync(ikm, salt, info, keylen) 参数顺序与 Buffer 类型
export function deriveAssetKey(tokenStr, name, version) {
  const ikm = Buffer.from(tokenStr, 'utf8');
  const salt = Buffer.from(ASSET_SALT, 'utf8');
  const info = Buffer.from(name + ':' + version, 'utf8');
  // hkdfSync 返回 ArrayBuffer，AES 需要 Buffer，包一层保持类型一致
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
}

// AES-256-GCM 加密，返回 { iv, tag, data }（均 base64）
export function encryptAsset(keyBuf, plainBuf) {
  // GCM 推荐 12 字节 IV
  const iv = Buffer.from(cryptoRandom(12));
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
}

// 对称解密，供测试验证 sha256 用
export function decryptAsset(keyBuf, ivB64, tagB64, dataB64) {
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec;
}

// 从私钥 PEM 派生公钥 PEM，供 keygen 与测试复用
export function derivePublicKeyPem(privateKeyPem) {
  const priv = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(priv);
  return pub.export({ type: 'spki', format: 'pem' });
}

function cryptoRandom(n) {
  // 用 randomFillSync 而非 Math.random，GCM 的 IV 必须不可预测
  const buf = Buffer.alloc(n);
  randomFillSync(buf);
  return buf;
}
