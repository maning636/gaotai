import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts 的上一级是 license-server 根目录
const ROOT = resolve(__dirname, '..');

// 生成 Ed25519 密钥对
// 私钥写 keys/ed25519-private.pem（0600，不入库、不进 git）
// 公钥打印成 PEM 供客户端内嵌
export function main() {
  const keyDir = resolve(ROOT, 'keys');
  const privPath = resolve(keyDir, 'ed25519-private.pem');

  // 已存在则拒绝覆盖，避免误删在用的私钥
  if (existsSync(privPath)) {
    console.error(`私钥已存在：${privPath}`);
    console.error('如需重新生成，请先备份并删除该文件。');
    process.exit(1);
  }

  if (!existsSync(keyDir)) {
    mkdirSync(keyDir, { recursive: true });
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  writeFileSync(privPath, privPem, 'utf8');
  // 0600：仅属主可读写，协议 §8 要求
  chmodSync(privPath, 0o600);

  console.log('私钥已写入：' + privPath + '（权限 0600）');
  console.log('');
  console.log('公钥 PEM（客户端内嵌用）：');
  console.log('-----BEGIN PUBLIC KEY-----');
  // 打印纯净的 base64 部分，去掉 PEM 头尾与换行，方便嵌入源码
  const body = pubPem.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').trim();
  console.log(body);
  console.log('-----END PUBLIC KEY-----');
  console.log('');
  console.log('完整 PEM：');
  console.log(pubPem);
}

main();
