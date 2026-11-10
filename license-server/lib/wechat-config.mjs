// 微信公众号配置加载/保存：从 <dataDir>/wechat.json 读取与写入。
//
// 读取：
//  - 文件不存在时用内置默认值，并自动写一份默认文件（方便运维直接改）。
//  - 读取/解析失败降级到默认值并 console.warn，绝不让回调 500——
//    微信对 5xx 会重试，配置坏了不该把整条回调链路打挂。
//  - 文件已存在时**深合并**：用默认配置补齐缺失的键。数组（products/faq/listKeywords）
//    整体替换，不逐项合并；对象（menu）浅合并。这样老文件即使缺新字段（如 faq）
//    也能读到默认值，不会因为「文件已存在就只读文件内容」而丢掉新配置。
//
// 保存：
//  - saveWechatConfig：校验结构后原子写（临时文件 + rename），返回 { ok, error? }。
//    非法结构拒绝写入且**不覆盖原文件**，避免一次手误把线上文案清空。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 内置默认配置：产品、关键词、文案。运维可直接改 wechat.json。
export const DEFAULT_WECHAT_CONFIG = {
  welcome:
    '谢谢你关注。\n\n我是马哥，在做几个小工具，都免费，用之前领一个注册码。\n\n' +
    '· 稿台（公众号写作工作台）：在这里发「稿台」，我直接把码发给你\n' +
    '· 也可以用电脑打开 https://license.maning789link.top/redeem 用邮箱领\n\n' +
    '发「领码」看全部产品，发「怎么用」看激活步骤。',
  products: [
    {
      key: 'gaotai',
      name: '稿台',
      keywords: ['稿台', '写作', '公众号'],
      issue: true,
      url: 'https://license.maning789link.top/redeem',
      replySuffix: '在客户端左侧「系统 → 授权」里填这个码，一码一机。',
    },
  ],
  listKeywords: ['领码', '全部', '产品', '帮助'],
  faq: [
    {
      keywords: ['怎么用', '激活', '使用方法', '不会用'],
      reply:
        '① 打开稿台客户端\n② 左侧「系统 → 授权」\n③ 把拿到的注册码填进去，点激活\n' +
        '④ 激活后会在「授权」页看到到期日，剩余不足 7 天会自动续期\n\n' +
        '电脑上没装？发「下载」我给你地址。',
    },
    {
      keywords: ['下载', '安装', '在哪下'],
      reply:
        '稿台安装包：https://license.maning789link.top/redeem 页面上方的产品入口里有下载地址。' +
        '装的时候如果 Windows 提示「已保护你的电脑」，点「更多信息 → 仍要运行」，安装包没有做数字签名。',
    },
    {
      keywords: ['更新', '新版', '升级'],
      reply: '有新版我会在这个号里发通知。升级不用重新领码，装新版本会沿用原来的授权。',
    },
  ],
  fallback:
    '发「稿台」领码，发「领码」看全部产品，发「怎么用」看激活步骤。有问题直接说，我看到会回。',
  menu: {},
};

// 判断普通对象（数组/函数/null 不算）。
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 深合并：用用户配置覆盖默认值，允许用户只改想改的字段。
// - 缺失的键用默认值补齐（数组整体替换，不逐项合并）；
// - 两边都是普通对象（如 menu）时浅合并一层，其余（数组/标量）整体用 override。
function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    const v = override[key];
    if (v === undefined) continue;
    if (isPlainObject(base[key]) && isPlainObject(v)) {
      out[key] = { ...base[key], ...v };
    } else {
      out[key] = v;
    }
  }
  return out;
}

// 校验配置结构：返回 { ok, errors }。非法时保存/加载都不应继续。
export function validateWechatConfig(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ['配置必须是对象'] };
  }
  if (typeof obj.welcome !== 'string') errors.push('welcome 必须是字符串');
  if (typeof obj.fallback !== 'string') errors.push('fallback 必须是字符串');
  if (!Array.isArray(obj.listKeywords) || obj.listKeywords.some((k) => typeof k !== 'string')) {
    errors.push('listKeywords 必须是字符串数组');
  }
  if (!Array.isArray(obj.products)) {
    errors.push('products 必须是数组');
  } else {
    obj.products.forEach((p, i) => {
      if (!isPlainObject(p)) {
        errors.push(`products[${i}] 必须是对象`);
        return;
      }
      if (typeof p.key !== 'string' || !p.key.trim()) errors.push(`products[${i}].key 必须是非空字符串`);
      if (typeof p.name !== 'string' || !p.name.trim()) errors.push(`products[${i}].name 必须是非空字符串`);
      if (!Array.isArray(p.keywords) || p.keywords.some((k) => typeof k !== 'string')) {
        errors.push(`products[${i}].keywords 必须是字符串数组`);
      }
      if (typeof p.issue !== 'boolean') errors.push(`products[${i}].issue 必须是布尔值`);
      if (p.url !== undefined && typeof p.url !== 'string') errors.push(`products[${i}].url 必须是字符串`);
      if (p.replySuffix !== undefined && typeof p.replySuffix !== 'string') {
        errors.push(`products[${i}].replySuffix 必须是字符串`);
      }
      // 可选扩展：发码后端与有效期（标书 15 天试用码用）。
      // issueBackend 缺省 = 'local'（稿台码，本地 store）；'bidmaster-api' = 调标书服务器建码。
      if (p.issueBackend !== undefined && !['local', 'bidmaster-api'].includes(p.issueBackend)) {
        errors.push(`products[${i}].issueBackend 必须是 'local' 或 'bidmaster-api'`);
      }
      if (p.validityDays !== undefined && (!Number.isInteger(p.validityDays) || p.validityDays < 1 || p.validityDays > 365)) {
        errors.push(`products[${i}].validityDays 必须是 1~365 的整数`);
      }
    });
  }
  if (!Array.isArray(obj.faq)) {
    errors.push('faq 必须是数组');
  } else {
    obj.faq.forEach((f, i) => {
      if (!isPlainObject(f)) {
        errors.push(`faq[${i}] 必须是对象`);
        return;
      }
      if (!Array.isArray(f.keywords) || f.keywords.some((k) => typeof k !== 'string')) {
        errors.push(`faq[${i}].keywords 必须是字符串数组`);
      }
      if (typeof f.reply !== 'string') errors.push(`faq[${i}].reply 必须是字符串`);
    });
  }
  if (!isPlainObject(obj.menu)) errors.push('menu 必须是对象');
  return { ok: errors.length === 0, errors };
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
    const merged = mergeConfig(DEFAULT_WECHAT_CONFIG, parsed);
    // 结构兜底：文件是合法 JSON 但字段形状不对（如 products 变字符串）时，
    // 同样降级到默认配置，避免回调 500。与解析失败走同一条降级路径。
    if (!validateWechatConfig(merged).ok) {
      console.warn(`wechat.json 结构不合法，降级到默认配置（${path}）`);
      return { config: DEFAULT_WECHAT_CONFIG, path };
    }
    return { config: merged, path };
  } catch (e) {
    console.warn(`wechat.json 读取失败，降级到默认配置（${path}）：${e.message}`);
    return { config: DEFAULT_WECHAT_CONFIG, path };
  }
}

// 原子写配置到 <dataDir>/wechat.json：先写临时文件再 rename，避免写到一半被杀留下半截 JSON。
// 校验失败返回 { ok:false, error } 且不写盘；成功返回 { ok:true }。
export function saveWechatConfig(dataDir, obj) {
  const v = validateWechatConfig(obj);
  if (!v.ok) {
    return { ok: false, error: '配置结构非法：' + v.errors.join('；') };
  }
  const path = resolve(dataDir, 'wechat.json');
  try {
    mkdirSync(dataDir, { recursive: true });
    const tmp = path + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, path);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '写入失败：' + e.message };
  }
}
