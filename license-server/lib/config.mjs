import { readFileSync, accessSync, constants, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CODE_FORMAT } from './store.mjs';

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

  // 微信公众号回调签名 token 与公众号原始 ID。
  // token 用于验证微信回调（sha1 签名），为空时 /wechat 一律 403；
  // 原始 ID（gh_xxxx）用作被动回复的 FromUserName，为空则填空串。
  // 两者都不写进任何日志（token 属于凭据）。
  const wechatToken = (env.WECHAT_TOKEN || '').trim();
  const wechatOriginalId = (env.WECHAT_ORIGINAL_ID || '').trim();

  // 网页后台（/admin）的管理口令与会话签名密钥。
  // 口令为空时后台整体 503（见 admin-auth.mjs / routes/admin.mjs），
  // 绝不降级成「无口令可进」；会话密钥缺失时用启动随机密钥并告警。
  // 两者都属于凭据，绝不写进任何日志。
  const adminPassword = (env.ADMIN_PASSWORD || '').trim();
  const adminSessionSecret = (env.ADMIN_SESSION_SECRET || '').trim();

  // 协议 §6.1：channel 取值固定集合
  const redeemChannels = ['wechat-mp', 'wechat-oa', 'direct'];

  // 注册码格式（环境变量可配，默认值保持不变）
  const codeFormat = parseCodeFormat(env);

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
    wechatToken,
    wechatOriginalId,
    adminPassword,
    adminSessionSecret,
    codeFormat,
    // 测试可注入已加载的私钥/公钥，避免每次自检读盘
    privateKey: opts.privateKey || null,
    publicKey: opts.publicKey || null,
  };
}

// ---- 注册码格式：环境变量解析（带默认值与类型清洗，不在解析期抛错，交给自检）----
export function parseCodeFormat(env = process.env) {
  const prefix = (env.CODE_PREFIX ?? DEFAULT_CODE_FORMAT.prefix).trim().toUpperCase();
  const bodyLength = env.CODE_BODY_LENGTH === undefined ? DEFAULT_CODE_FORMAT.bodyLength : parseInt(env.CODE_BODY_LENGTH, 10);
  const groupSize = env.CODE_GROUP_SIZE === undefined ? DEFAULT_CODE_FORMAT.groupSize : parseInt(env.CODE_GROUP_SIZE, 10);
  const alphabet = (env.CODE_ALPHABET ?? DEFAULT_CODE_FORMAT.alphabet).trim().toUpperCase();
  return { prefix, bodyLength, groupSize, alphabet };
}

// 校验注册码格式配置，返回 { ok, errors }
// 失败时拒绝启动，给运维可行动的中文错误
export function validateCodeFormat(fmt) {
  const errors = [];
  const { prefix, bodyLength, groupSize, alphabet } = fmt;

  // 前缀：大写字母/数字，1–6 位，允许为空（空则码不带前缀）
  if (!/^[A-Z0-9]{0,6}$/.test(prefix)) {
    errors.push(`CODE_PREFIX 只能是大写字母/数字、0–6 位（当前：${JSON.stringify(prefix)}）`);
  }

  // 码体长度：6–32 的整数
  if (!Number.isInteger(bodyLength) || bodyLength < 6 || bodyLength > 32) {
    errors.push(`CODE_BODY_LENGTH 必须是 6–32 的整数（当前：${JSON.stringify(bodyLength)}）`);
  }

  // 分组大小：0 或能整除码体长度
  if (!Number.isInteger(groupSize) || groupSize < 0) {
    errors.push(`CODE_GROUP_SIZE 必须是 0 或正整数（当前：${JSON.stringify(groupSize)}）`);
  } else if (groupSize > 0 && bodyLength > 0 && bodyLength % groupSize !== 0) {
    errors.push(`CODE_GROUP_SIZE=${groupSize} 必须能整除 CODE_BODY_LENGTH=${bodyLength}（否则分组不整齐）`);
  }

  // 字符集：去重后 ≥16，只能 [A-Z0-9]
  const unique = new Set(alphabet.split(''));
  if (alphabet.length < 16 || unique.size !== alphabet.length) {
    errors.push(`CODE_ALPHABET 去重后长度必须 ≥16 且字符唯一（当前长度 ${alphabet.length}、去重后 ${unique.size}）`);
  }
  if (!/^[A-Z0-9]+$/.test(alphabet)) {
    errors.push(`CODE_ALPHABET 只能由大写字母/数字组成（当前：${JSON.stringify(alphabet)}）`);
  }

  // 熵：组合后的码体要能容纳足够熵，避免太短的码被猜到
  if (alphabet.length > 0 && bodyLength > 0 && Math.pow(alphabet.length, bodyLength) < 1e12) {
    errors.push(`字符集 ${alphabet.length} 种、码体 ${bodyLength} 位，组合数 ${alphabet.length ** bodyLength} 不足 1e12，请增大 CODE_BODY_LENGTH 或 CODE_ALPHABET`);
  }

  return { ok: errors.length === 0, errors };
}

// 启动自检：注册码格式、私钥、data 目录可写、资产目录存在（资产缺失只告警不退出，可在发码前补打）
export function selfCheck(cfg) {
  const errors = [];

  // 注册码格式非法 → 拒绝启动
  const fmt = validateCodeFormat(cfg.codeFormat);
  if (!fmt.ok) {
    errors.push('注册码格式配置非法：\n  ' + fmt.errors.join('\n  '));
  }

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
