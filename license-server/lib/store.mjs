import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Crockford Base32 字符集，去掉了 I L O U，降低手抄抄错率
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 注册码格式 GT-XXXX-XXXX-XXXX-XXXX，4 段 4 位
const CODE_GROUPS = 4;
const CODE_GROUP_LEN = 4;

// 规范化注册码：大写、去空格、接受用户输入的 GT 前缀或无前缀
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.toUpperCase().replace(/\s+/g, '');
  // 用户可能输小写 o 当 0、小写 l 当 1，Crockford 约定映射
  s = s.replace(/O/g, '0').replace(/L/g, '1').replace(/I/g, '1');
  // 去掉连字符与可能的 GT 前缀，只留 16 位码体
  let clean = s.replace(/-/g, '');
  if (clean.startsWith('GT')) {
    clean = clean.slice(2);
  }
  if (clean.length !== CODE_GROUPS * CODE_GROUP_LEN) return '';
  // Crockford Base32 去掉 I L O U，字符范围：0-9 A-H J-N P-T V-Z
  if (!/^[0-9A-HJ-NP-TV-Z]+$/.test(clean)) return '';
  return 'GT-' + clean.match(/.{4}/g).join('-');
}

// 用 crypto.randomInt 逐段生成，碰撞重试
// randomInt 从外部注入，避免在 ESM 里用 require
export function generateCode(store, randomInt, maxTries = 1000) {
  for (let i = 0; i < maxTries; i++) {
    let groups = [];
    for (let g = 0; g < CODE_GROUPS; g++) {
      let part = '';
      for (let c = 0; c < CODE_GROUP_LEN; c++) {
        part += CROCKFORD[randomInt(CROCKFORD.length)];
      }
      groups.push(part);
    }
    const code = 'GT-' + groups.join('-');
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

export function createStore({ dataDir, now = Date.now }) {
  const dbPath = resolve(dataDir, 'license.json');
  const auditPath = resolve(dataDir, 'audit.jsonl');
  const queue = createQueue();

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
