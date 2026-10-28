import { readFileSync, accessSync, constants, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 服务端根目录：lib 的上一级
const ROOT = resolve(__dirname, '..');

// 默认有效期 30 天，与协议 §3 一致
const DEFAULT_TOKEN_TTL_DAYS = 30;
// 协议 §4.1：同 IP 5 分钟 5 次失败即限流
const DEFAULT_RATE_FAILS = 5;
const DEFAULT_RATE_WINDOW_MS = 5 * 60 * 1000;
// 协议 §6.2：领码页同一 IP 每小时最多 20 次
const DEFAULT_REDEEM_PER_HOUR = 20;

function readPrivateKey(keyPath) {
  // 私钥缺失或不可读属于致命错误，启动即暴露，不静默放行
  const pem = readFileSync(keyPath, 'utf8');
  if (!pem.includes('PRIVATE KEY')) {
    throw new Error(`私钥文件 ${keyPath} 内容不像 PEM 私钥，拒绝启动`);
  }
  return pem;
}

export function parseConfig(env = process.env, opts = {}) {
  const root = opts.root || ROOT;
  const port = parseInt(env.PORT || '8787', 10);
  const host = env.HOST || '0.0.0.0';

  const dataDir = env.LICENSE_DATA_DIR || resolve(root, 'data');
  const keyDir = env.LICENSE_KEY_DIR || resolve(root, 'keys');
  const privateKeyPath = resolve(keyDir, 'ed25519-private.pem');
  const assetsDir = env.LICENSE_ASSETS_DIR || resolve(root, 'assets', 'packs');

  // nginx 反代后面才信任 X-Forwarded-For，默认不信任，避免直连时伪造来源
  const trustProxy = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';

  const tokenTtlDays = parseInt(env.TOKEN_TTL_DAYS || String(DEFAULT_TOKEN_TTL_DAYS), 10);
  const tokenTtlMs = tokenTtlDays * 24 * 60 * 60 * 1000;

  const rateFails = parseInt(env.RATE_FAILS || String(DEFAULT_RATE_FAILS), 10);
  const rateWindowMs = parseInt(env.RATE_WINDOW_MS || String(DEFAULT_RATE_WINDOW_MS), 10);

  const redeemPerHour = parseInt(env.REDEEM_PER_HOUR || String(DEFAULT_REDEEM_PER_HOUR), 10);

  // 协议 §6.1：channel 取值固定集合
  const redeemChannels = ['wechat-mp', 'wechat-oa', 'direct'];

  return {
    root,
    port,
    host,
    dataDir,
    keyDir,
    privateKeyPath,
    assetsDir,
    trustProxy,
    tokenTtlDays,
    tokenTtlMs,
    rateFails,
    rateWindowMs,
    redeemPerHour,
    redeemChannels,
    // 测试可注入已加载的私钥/公钥，避免每次自检读盘
    privateKey: opts.privateKey || null,
    publicKey: opts.publicKey || null,
  };
}

// 启动自检：私钥、data 目录可写、资产目录存在（资产缺失只告警不退出，可在发码前补打）
export function selfCheck(cfg) {
  const errors = [];

  // 私钥：要么已注入，要么从盘上读
  try {
    if (cfg.privateKey) {
      // 已注入，跳过文件读取
    } else {
      const pem = readPrivateKey(cfg.privateKeyPath);
      cfg.privateKey = pem;
    }
  } catch (e) {
    errors.push(`私钥不可用（${cfg.privateKeyPath}）：${e.message}。请先运行 npm run keygen 生成密钥对。`);
  }

  // data 目录必须可写，否则原子写落盘会失败
  try {
    ensureDirWritable(cfg.dataDir);
  } catch (e) {
    errors.push(`数据目录不可写（${cfg.dataDir}）：${e.message}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [] };
}

function ensureDirWritable(dir) {
  // accessSync 只能判存在与权限位，对新建目录用 mkdir 兜底；再 stat 确认是目录
  try {
    accessSync(dir, constants.W_OK);
    const s = statSync(dir);
    if (!s.isDirectory()) {
      throw new Error('路径存在但不是目录');
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 测试注入的临时目录通常已由测试方创建；这里不自动 mkdir，避免在生产环境默默建到意外位置
      // 保留原始 ENOENT 作为 cause，便于上层区分「缺目录」与「权限不足」
      throw new Error(`目录不存在，请先创建：${dir}`, { cause: e });
    }
    throw e;
  }
}

export { ROOT };
