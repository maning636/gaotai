// 客户端版本策略加载/保存：从 <dataDir>/app.json 读取与写入。
//
// 结构（缺文件时写默认值）：
//   {
//     "latest": "0.2.0",          // 最新版本号
//     "minSupported": "0.2.0",    // 最低支持版本：低于它 → blocked（强制更新）
//     "mode": "link",             // 下载方式：link（外链）| direct（直链）
//     "url": "https://pan.quark.cn/s/xxxx",  // 下载地址，必须 https:// 开头
//     "notes": ""                 // 更新说明，≤2000 字
//   }
//
// 读取：
//  - 文件不存在时写一份默认值（方便运维直接改）；
//  - 读取/解析失败或字段形状不对 → 降级默认值并 console.warn，绝不让接口 500
//    （客户端每次启动都会调这个接口，坏配置不该把升级探测链路打挂）；
//  - 文件已存在时用默认值补齐缺失键（浅合并），老文件缺新键也能读到默认值。
//
// 保存：
//  - saveAppPolicy：先校验再原子写（临时文件 + rename），非法返回 { ok:false, error }
//    且不覆盖原文件，避免一次手误把线上策略清空。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 内置默认版本策略。
export const DEFAULT_APP_POLICY = {
  latest: '0.2.0',
  minSupported: '0.2.0',
  mode: 'link',
  url: 'https://pan.quark.cn/s/xxxx',
  notes: '',
};

// 判断普通对象（数组/函数/null 不算）。
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 把字符串解析成 [major, minor, patch]，缺省位补 0。
// 只接受 `1.2.3`、`1.2`、`1` 这三种写法（1–3 段十进制数），其余（含空串、
// 带前导空格、带字母/连字符/前缀、超过 3 段）返回 null。
// 返回的数组长度与传入段数一致（1.2 → [1,2]，1.2.0 → [1,2,0]），便于比较时按需补位。
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]]
    .filter((x) => x !== undefined)
    .map((x) => Number(x));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return parts;
}

// 判断是否为合法版本号（供校验与接口判定使用）。
export function isValidVersion(v) {
  return parseVersion(v) !== null;
}

// 语义化版本比较：a > b → 1，a < b → -1，a == b → 0。
// 支持 `1.2.3` 与 `1.2`（缺位按 0 补齐，1.0 == 1.0.0）。
// 任一参数非法返回 null——调用方据此把 dirty 数据当「不阻断」处理，
// 绝不让脏数据把升级探测接口打挂。
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

// 校验版本策略结构：返回 { ok, errors }。非法时保存/加载都不应继续。
export function validatePolicy(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ['配置必须是对象'] };
  }
  if (!isValidVersion(obj.latest)) {
    errors.push('latest 必须是合法版本号（如 1.2.3 或 1.2）');
  }
  if (!isValidVersion(obj.minSupported)) {
    errors.push('minSupported 必须是合法版本号（如 1.2.3 或 1.2）');
  }
  if (obj.mode !== 'link' && obj.mode !== 'direct') {
    errors.push('mode 只能是 link 或 direct');
  }
  // mode=link|direct 时下载地址必须 https；当前 mode 只有这两种取值，
  // 故统一要求 https:// 开头，避免把客户端引到明文或非 HTTP(S) 链接。
  if (typeof obj.url !== 'string' || !obj.url.startsWith('https://')) {
    errors.push('url 必须是 https:// 开头的链接');
  }
  if (typeof obj.notes !== 'string' || obj.notes.length > 2000) {
    errors.push('notes 必须是字符串且长度不超过 2000');
  }
  return { ok: errors.length === 0, errors };
}

// 从 dataDir 读版本策略；文件不存在自动落一份默认文件。
// 返回的配置对象保证有全部默认字段（缺键补齐）。
export function loadAppPolicy(dataDir) {
  const path = resolve(dataDir, 'app.json');
  try {
    if (!existsSync(path)) {
      // 首次运行：写默认文件，方便运维直接改。写失败不致命（用内存默认值继续）。
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path, JSON.stringify(DEFAULT_APP_POLICY, null, 2), 'utf8');
      return { config: { ...DEFAULT_APP_POLICY }, path };
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // 浅合并：用默认值补齐缺失键；解析结果是数组/标量时整体忽略，走降级。
    const merged = { ...DEFAULT_APP_POLICY, ...(isPlainObject(parsed) ? parsed : {}) };
    // 结构兜底：字段形状不对（如 latest 变数字、mode 变非法值）同样降级默认，
    // 避免升级探测接口 500。与解析失败走同一条降级路径。
    if (!validatePolicy(merged).ok) {
      console.warn(`app.json 结构不合法，降级到默认版本策略（${path}）`);
      return { config: { ...DEFAULT_APP_POLICY }, path };
    }
    return { config: merged, path };
  } catch (e) {
    console.warn(`app.json 读取失败，降级到默认版本策略（${path}）：${e.message}`);
    return { config: { ...DEFAULT_APP_POLICY }, path };
  }
}

// 原子写版本策略到 <dataDir>/app.json：先写临时文件再 rename，避免写到一半被杀留下半截 JSON。
// 校验失败返回 { ok:false, error } 且不写盘；成功返回 { ok:true }。
export function saveAppPolicy(dataDir, obj) {
  const v = validatePolicy(obj);
  if (!v.ok) {
    return { ok: false, error: '版本策略非法：' + v.errors.join('；') };
  }
  const path = resolve(dataDir, 'app.json');
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
