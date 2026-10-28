// 微信公众号配置加载：从 <dataDir>/wechat.json 读取。
//
// 文件不存在时用内置默认值，并自动写一份默认文件（方便运维直接改）。
// 读取/解析失败降级到默认值并 console.warn，绝不让回调 500——
// 微信对 5xx 会重试，配置坏了不该把整条回调链路打挂。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 内置默认配置：产品、关键词、文案。运维可直接改 wechat.json。
export const DEFAULT_WECHAT_CONFIG = {
  welcome: '谢谢你关注。\n\n发「稿台」领稿台的注册码，发「领码」看全部产品。',
  products: [
    {
      key: 'gaotai',
      name: '稿台',
      keywords: ['稿台', '写作'],
      issue: true,
      url: 'https://license.maning789link.top/redeem',
      replySuffix: '在客户端「系统 → 授权」里填这个码，一码一机。',
    },
  ],
  listKeywords: ['领码', '全部', '产品', '帮助'],
  fallback: '发「稿台」领码，发「领码」看全部产品。有问题直接说。',
  menu: {},
};

// 深合并：用用户配置覆盖默认值，允许用户只改想改的字段。
// 只合并一层（products/menu 这类数组与对象整体替换），避免对数组做深合并导致意外。
function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    const v = override[key];
    if (v === undefined) continue;
    if (key === 'menu' && v && typeof v === 'object') {
      out.menu = { ...(base.menu || {}), ...v };
    } else {
      out[key] = v;
    }
  }
  return out;
}

// 从 dataDir 读配置；文件不存在自动落一份默认文件。返回的配置对象保证有全部默认字段。
export function loadWechatConfig(dataDir) {
  const path = resolve(dataDir, 'wechat.json');
  try {
    if (!existsSync(path)) {
      // 首次运行：写默认文件，方便运维直接改。写失败不致命（用内存默认值继续）。
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path, JSON.stringify(DEFAULT_WECHAT_CONFIG, null, 2), 'utf8');
      return { config: DEFAULT_WECHAT_CONFIG, path };
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { config: mergeConfig(DEFAULT_WECHAT_CONFIG, parsed), path };
  } catch (e) {
    console.warn(`wechat.json 读取失败，降级到默认配置（${path}）：${e.message}`);
    return { config: DEFAULT_WECHAT_CONFIG, path };
  }
}
