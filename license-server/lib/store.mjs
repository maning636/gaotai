import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Crockford Base32 字符集，去掉了 I L O U，降低手抄抄错率
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 默认注册码格式：GT-XXXX-XXXX-XXXX-XXXX，4 段 4 位
// 通过环境变量 CODE_PREFIX / CODE_BODY_LENGTH / CODE_GROUP_SIZE / CODE_ALPHABET 可覆盖，
// 默认值保持不变，保证现有部署与已发出去的码继续有效。
export const DEFAULT_CODE_FORMAT = {
  prefix: 'GT',
  bodyLength: 16,
  groupSize: 4,
  alphabet: CROCKFORD,
};

// 判断两个格式是否等价（未传入按默认格式算）
export function sameFormat(a, b) {
  const x = a || DEFAULT_CODE_FORMAT;
  const y = b || DEFAULT_CODE_FORMAT;
  return (
    x.prefix === y.prefix &&
    x.bodyLength === y.bodyLength &&
    x.groupSize === y.groupSize &&
    x.alphabet === y.alphabet
  );
}

// 按格式组装注册码：PREFIX-分组1-分组2-...
// groupSize 为 0 表示不分段；prefix 为空则码体直接分组
function assembleCode(prefix, body, groupSize) {
  const grouped = groupSize > 0 ? body.match(new RegExp('.{' + groupSize + '}', 'g')).join('-') : body;
  return prefix ? prefix + '-' + grouped : grouped;
}

// 规范化注册码：大写、去空格、容忍漏输前缀 / 大小写混写 / 中间夹空格
// format 缺省用默认格式（GT/16/4），保证老调用方行为不变
export function normalizeCode(raw, format = DEFAULT_CODE_FORMAT) {
  if (typeof raw !== 'string') return '';
  const { prefix, bodyLength, groupSize, alphabet } = format;
  let s = raw.toUpperCase().replace(/\s+/g, '');
  // 用户可能输小写 o 当 0、小写 l 当 1，Crockford 约定映射；
  // 仅当目标字符在字符集内才做映射，避免自定义字符集被误改
  if (alphabet.includes('0')) s = s.replace(/O/g, '0');
  if (alphabet.includes('1')) s = s.replace(/L/g, '1').replace(/I/g, '1');
  // 去掉连字符，只留码体（含可能带上的前缀）
  const clean = s.replace(/-/g, '');
  const allowed = new Set(alphabet);

  // 收集候选码体：优先「剥掉前缀」的版本，再试「原样」，
  // 这样既能接受带前缀的规范输入，也能容忍用户漏输前缀（且码体恰好以 prefix 开头）
  const candidates = [];
  if (prefix && clean.startsWith(prefix)) {
    candidates.push(clean.slice(prefix.length));
  }
  candidates.push(clean);

  for (const body of candidates) {
    if (body.length !== bodyLength) continue;
    let ok = true;
    for (const ch of body) {
      if (!allowed.has(ch)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    return assembleCode(prefix, body, groupSize);
  }
  return '';
}

// 用 crypto.randomInt 逐位生成，碰撞重试
// randomInt 从外部注入，避免在 ESM 里用 require
export function generateCode(store, randomInt, format = DEFAULT_CODE_FORMAT, maxTries = 1000) {
  const { prefix, bodyLength, groupSize, alphabet } = format;
  for (let i = 0; i < maxTries; i++) {
    let body = '';
    for (let c = 0; c < bodyLength; c++) {
      body += alphabet[randomInt(alphabet.length)];
    }
    const code = assembleCode(prefix, body, groupSize);
    if (!store.findCode(code)) {
      return code;
    }
  }
  throw new Error('生成注册码连续碰撞，请重试或扩充字符集');
}

// contact 规范化：trim 后小写化手机号（11 位数字），微信号保持原样小写
export function normalizeContact(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  // 纯数字视为手机号，小写化无副作用；微信号统一小写便于幂等比对
  s = s.toLowerCase();
  return s;
}

// 验证 contact 至少有 2 个字符，避免空串或单字符占位
export function isValidContact(raw) {
  const s = normalizeContact(raw);
  return s.length >= 2 && s.length <= 64;
}

// 并发串行化：所有写操作排队执行，避免读写交错损坏 JSON
function createQueue() {
  let tail = Promise.resolve();
  function enqueue(fn) {
    const run = tail.then(fn, fn);
    // 吞掉异常，不让队列永久 reject
    tail = run.then(() => {}, () => {});
    return run;
  }
  return { enqueue };
}

export function createStore({ dataDir, now = Date.now, codeFormat }) {
  const dbPath = resolve(dataDir, 'license.json');
  const auditPath = resolve(dataDir, 'audit.jsonl');
  const queue = createQueue();
  // 保存注册码格式（默认值保持不变），供 lookup 时做兼容解析；
  // 不作为模块级全局，便于同一进程内测试多种 format
  const fmt = codeFormat || DEFAULT_CODE_FORMAT;

  // 确保目录存在，data/.gitkeep 已在仓库里，但测试注入的临时目录可能没有
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  function load() {
    if (!existsSync(dbPath)) {
      return { codes: {}, contacts: {} };
    }
    try {
      const raw = readFileSync(dbPath, 'utf8');
      const obj = JSON.parse(raw);
      // 结构兜底，老数据缺字段时补齐
      return {
        codes: obj.codes || {},
        contacts: obj.contacts || {},
      };
    } catch (e) {
      // 数据文件损坏属于致命情况，宁可暴露也不要静默覆写丢数据
      throw new Error(`license.json 解析失败（${dbPath}）：${e.message}`, { cause: e });
    }
  }

  // 原子写：先写临时文件再 rename，避免写到一半进程被杀导致半截 JSON
  function persist(db) {
    const tmp = dbPath + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    renameSync(tmp, dbPath);
  }

  // 审计日志追加写，JSONL 每行一条
  // 协议 §8：只记 code 前 4 位、IP、错误码、时间，绝不记完整 contact/token/私钥
  function appendAudit({ ip, codePrefix, errorCode, event }) {
    const line = JSON.stringify({
      t: now(),
      ip: ip || '',
      codePrefix: codePrefix || '',
      errorCode: errorCode || '',
      event: event || '',
    });
    appendFileSync(auditPath, line + '\n', 'utf8');
  }

  // ---- 激活码 CRUD ----

  function findCode(code) {
    return load().codes[code] || null;
  }

  // 查码（兼容感知）：先按当前 format 规范化后精确匹配；若匹配不到、且 format 与默认不同，
  // 再按默认格式（GT/16/4）规范化试一次，让库里已有的旧格式码仍能激活。
  // 返回 { code, record }：
  //   - 命中时 code 为库里实际使用的规范化字符串（可能是旧格式，供后续 CRUD 精确命中）
  //   - 未命中时 record 为 null；code 为「当前格式或旧格式」下最合理的规范化串，
  //     非空表示 raw 格式合法（调用方可据此区分 400 格式错 与 404 码不存在）
  function resolveCode(raw) {
    const db = load();
    const cur = normalizeCode(raw, fmt);
    if (cur && db.codes[cur]) return { code: cur, record: db.codes[cur] };
    if (!sameFormat(fmt, DEFAULT_CODE_FORMAT)) {
      const legacy = normalizeCode(raw, DEFAULT_CODE_FORMAT);
      if (legacy && db.codes[legacy]) return { code: legacy, record: db.codes[legacy] };
      // 旧格式规范化成功但库里没有 → 交给调用方报「码不存在」；否则退回当前格式结果
      if (legacy) return { code: legacy, record: null };
    }
    return { code: cur, record: null };
  }

  // 发码：写入新激活码记录，contact 幂等
  function issueCode({ code, contact, channel, note, plan = 'free', features, maxDevices = 1 }) {
    return queue.enqueue(() => {
      const db = load();
      // contact 幂等：同一 contact 重复提交返回原码
      const existingCode = db.contacts[contact];
      if (existingCode && db.codes[existingCode]) {
        return db.codes[existingCode];
      }
      const record = {
        code,
        contact,
        channel: channel || 'direct',
        note: note || '',
        plan,
        features: features || ['core', 'skills', 'prompts', 'topics', 'layout-packs', 'illustration'],
        maxDevices,
        devices: [],
        revoked: false,
        createdAt: now(),
        lastSeenAt: null,
        lastTokenExpiresAt: null,
      };
      db.codes[code] = record;
      db.contacts[contact] = code;
      persist(db);
      return record;
    });
  }

  function listCodes() {
    return queue.enqueue(() => {
      const db = load();
      return Object.values(db.codes);
    });
  }

  function revoke(code) {
    return queue.enqueue(() => {
      const db = load();
      const r = db.codes[code];
      if (!r) return null;
      r.revoked = true;
      persist(db);
      return r;
    });
  }

  function unrevoke(code) {
    return queue.enqueue(() => {
      const db = load();
      const r = db.codes[code];
      if (!r) return null;
      r.revoked = false;
      persist(db);
      return r;
    });
  }

  function unbind(code, machine) {
    return queue.enqueue(() => {
      const db = load();
      const r = db.codes[code];
      if (!r) return null;
      if (machine) {
        r.devices = r.devices.filter((d) => d.machine !== machine);
      } else {
        r.devices = [];
      }
      persist(db);
      return r;
    });
  }

  // 绑定或放行：返回 { ok, record, error }
  // 同机重复激活幂等放行、不消耗名额；超限返回 device_limit
  function bindOrAllow(code, machine) {
    return queue.enqueue(() => {
      const db = load();
      const r = db.codes[code];
      if (!r) return { ok: false, error: 'invalid_code' };
      if (r.revoked) return { ok: false, error: 'code_revoked' };
      const existing = r.devices.find((d) => d.machine === machine);
      if (existing) {
        // 幂等放行，仅更新心跳
        existing.lastSeenAt = now();
        r.lastSeenAt = existing.lastSeenAt;
        persist(db);
        return { ok: true, record: r };
      }
      if (r.devices.length >= r.maxDevices) {
        return { ok: false, error: 'device_limit' };
      }
      r.devices.push({ machine, activatedAt: now(), lastSeenAt: now() });
      r.lastSeenAt = now();
      persist(db);
      return { ok: true, record: r };
    });
  }

  // refresh 用：只更新 lastSeenAt，不新增设备
  function touchSeen(code, machine) {
    return queue.enqueue(() => {
      const db = load();
      const r = db.codes[code];
      if (!r) return { ok: false, error: 'invalid_code' };
      if (r.revoked) return { ok: false, error: 'code_revoked' };
      const existing = r.devices.find((d) => d.machine === machine);
      if (!existing) return { ok: false, error: 'machine_mismatch' };
      existing.lastSeenAt = now();
      r.lastSeenAt = existing.lastSeenAt;
      persist(db);
      return { ok: true, record: r };
    });
  }

  function statusOf(code, machine) {
    return queue.enqueue(() => {
      const db = load();
      const r = db.codes[code];
      if (!r) return { ok: false, error: 'invalid_code' };
      const bound = r.devices.some((d) => d.machine === machine);
      return {
        ok: true,
        data: {
          activated: bound,
          revoked: r.revoked,
          expiresAt: r.lastTokenExpiresAt || null,
          lastSeenAt: r.lastSeenAt || null,
          plan: r.plan,
        },
      };
    });
  }

  // 记录签发 token 的过期时间，供 status 查询
  function setTokenExpiresAt(code, expiresAt) {
    return queue.enqueue(() => {
      const db = load();
      const r = db.codes[code];
      if (!r) return;
      r.lastTokenExpiresAt = expiresAt;
      persist(db);
      return r;
    });
  }

  function stats() {
    return queue.enqueue(() => {
      const db = load();
      const codes = Object.values(db.codes);
      return {
        total: codes.length,
        revoked: codes.filter((c) => c.revoked).length,
        active: codes.filter((c) => !c.revoked).length,
        boundDevices: codes.reduce((n, c) => n + c.devices.length, 0),
      };
    });
  }

  return {
    findCode,
    resolveCode,
    issueCode,
    listCodes,
    revoke,
    unrevoke,
    unbind,
    bindOrAllow,
    touchSeen,
    statusOf,
    setTokenExpiresAt,
    stats,
    appendAudit,
    _dbPath: dbPath,
    _auditPath: auditPath,
  };
}
