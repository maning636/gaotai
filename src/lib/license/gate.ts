import { getMachineId } from "./machine";
import { verifyToken } from "./token";
import { readTokenCache, writeTokenCache } from "./store";
import { refresh as refreshFromServer } from "./client";
import { resolveLicenseServer } from "./server-url";
import type {
  LicenseCache,
  LicenseSnapshot,
  LicenseState,
} from "./types";

/**
 * 进程内授权门禁（协议 §7）。
 *
 * - `getLicenseState()`：读缓存文件 → 验签 → 若剩余 < 7 天且距上次刷新 > 1 小时，尝试 refresh（失败不阻塞，返回带 `graceUntil` 的已过期状态）。
 * - 进程内缓存状态（`{ state, expiresAt, checkedAt }`），TTL 60 秒，避免每个请求都跑 PowerShell/fetch。
 * - `requireLicense(): Promise<Response|null>`：已激活/bypass 返回 null，否则返回 403 `{ error:'not_activated', code:'not_activated', message }`。
 * - `hasFeature(name)`、`licenseSnapshot()`（给 UI 用：status、code 打码、expiresAt、daysLeft、features、plan、serverConfigured）。
 * - `GAOTAI_LICENSE_BYPASS === '1'` 时 `status:'bypass'`，且打印一条 `console.warn`（防止偷偷带上生产）。
 * - `resetLicenseCache()` 供测试清缓存。
 */

/** 进程内缓存 TTL：60 秒内不重复读盘/不重复验签。 */
const CACHE_TTL_MS = 60_000;

/** 剩余不足 7 天触发刷新。 */
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** 距上次刷新超过 1 小时才再刷新（避免高频请求）。 */
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

/** 宽限期：刷新失败后给 7 天的 graceUntil。 */
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** 进程内缓存。 */
interface ProcCache {
  state: LicenseState;
  checkedAt: number;
}
let procCache: ProcCache | null = null;

/**
 * 判断是否走 bypass。
 *
 * `GAOTAI_LICENSE_BYPASS === '1'` 时放行。
 * 打印一条 `console.warn`，防止偷偷带上生产——
 * 打包脚本会剥离这个变量，但如果有人手动设了，至少控制台能看到。
 */
function isBypass(): boolean {
  if (process.env.GAOTAI_LICENSE_BYPASS === "1") {
    console.warn(
      "[gaotai/license] GAOTAI_LICENSE_BYPASS=1，授权门禁已放行。这仅用于开发/测试，不应出现在生产环境。",
    );
    return true;
  }
  return false;
}

/**
 * 把注册码打码：只留前 4 与后 2。
 *
 * `GT-7F3K-9QW2-M4XB-8HZP` → `GT-7...P`（太短的码全打星）。
 */
function maskCode(code: string): string {
  if (!code) return "";
  if (code.length <= 6) return "*".repeat(code.length);
  return `${code.slice(0, 4)}...${code.slice(-2)}`;
}

/**
 * 从缓存文件构建 LicenseState（验签 + machine + 过期）。
 *
 * 返回 null 表示缓存不可用（文件不存在/坏/token 验不过）。
 */
async function buildStateFromCache(machine: string): Promise<LicenseState | null> {
  const cache: LicenseCache | null = await readTokenCache();
  if (!cache) return null;

  // machine 不匹配：缓存是别的机器激活的，当坏缓存处理。
  if (cache.machine !== machine) return null;

  // token 验签 + 过期 + machine
  const result = verifyToken(cache.token, machine);
  if (!result.ok) {
    // 验签过了但过期了：进入宽限期（由调用方决定要不要 refresh）。
    // 这里先返回 expired，让 getLicenseState 去 refresh。
    if (result.reason === "expired") {
      return {
        status: "expired",
        code: cache.code,
        expiresAt: cache.expiresAt,
        // 宽限从「到期那一刻」起算，而不是从「每次读到」起算：
        // 否则每次读盘都把宽限往后推 7 天，等于永不过期，UI 上的天数也不可信。
        graceUntil: cache.expiresAt + GRACE_MS,
        features: cache.features,
        plan: cache.plan,
        machine,
      };
    }
    // bad_format / bad_signature / machine_mismatch：缓存不可信。
    return null;
  }

  const payload = result.payload;
  const now = Date.now();
  if (payload.expiresAt <= now) {
    // 理论上 verifyToken 已检查过期，这里双重保险。
    return {
      status: "expired",
      code: cache.code,
      expiresAt: cache.expiresAt,
      graceUntil: now + GRACE_MS,
      features: cache.features,
      plan: cache.plan,
      machine,
    };
  }

  return {
    status: "activated",
    code: cache.code,
    expiresAt: cache.expiresAt,
    features: cache.features,
    plan: cache.plan,
    machine,
  };
}

/**
 * 取当前授权状态。
 *
 * 流程：
 * 1. bypass 开 → `{ status:'bypass', machine }`
 * 2. 进程内缓存未过期（60s）→ 直接用
 * 3. 读缓存文件 → 验签 → 构建状态
 * 4. 剩余 < 7 天且距上次刷新 > 1 小时 → 尝试 refresh（失败不阻塞，返回带 graceUntil 的 expired）
 * 5. 缓存不可用 → `{ status:'missing', machine }`
 *
 * refresh 失败不阻塞：返回带 `graceUntil` 的 expired 状态，应用照常运行。
 */
export async function getLicenseState(): Promise<LicenseState> {
  const machine = await getMachineId();

  // bypass：最高优先级，直接放行。
  if (isBypass()) {
    return { status: "bypass", machine };
  }

  // 进程内缓存命中
  const now = Date.now();
  if (procCache && now - procCache.checkedAt < CACHE_TTL_MS) {
    return procCache.state;
  }

  // 读缓存文件
  let state = await buildStateFromCache(machine);

  if (state && state.status === "activated") {
    // 剩余 < 7 天 → 尝试 refresh
    const remaining = state.expiresAt - now;
    if (remaining < REFRESH_THRESHOLD_MS && shouldRefresh(now)) {
      state = await tryRefresh(state, machine, now);
    }
  } else if (state && state.status === "expired") {
    // 已过期也尝试 refresh（冷却时间够的话）
    if (shouldRefresh(now)) {
      state = await tryRefresh(state, machine, now);
    }
  }

  const finalState: LicenseState = state ?? { status: "missing", machine };
  procCache = { state: finalState, checkedAt: now };
  return finalState;
}

/**
 * 判断是否到了可以 refresh 的时间点（距上次刷新 > 1 小时）。
 *
 * 用进程内变量记录上次刷新时间；测试可通过 `resetLicenseCache()` 清零。
 */
let lastRefreshAt = 0;
function shouldRefresh(now: number): boolean {
  return now - lastRefreshAt > REFRESH_COOLDOWN_MS;
}

/**
 * 尝试 refresh：调服务端，成功则写缓存并返回 activated，失败返回原状态的 expired（带 graceUntil）。
 *
 * 失败不阻塞：网络不通、服务器返回错误，都不影响当前已过期的 token 在宽限期内继续用。
 */
async function tryRefresh(
  current: LicenseState,
  machine: string,
  now: number,
): Promise<LicenseState> {
  lastRefreshAt = now;
  if (current.status !== "activated" && current.status !== "expired") return current;

  const result = await refreshFromServer({ code: current.code, machine });
  if (!result.ok) {
    // 失败：返回 expired 状态（带 graceUntil）
    if (current.status === "activated") {
      return {
        status: "expired",
        code: current.code,
        expiresAt: current.expiresAt,
        graceUntil: now + GRACE_MS,
        features: current.features,
        plan: current.plan,
        machine,
      };
    }
    return current;
  }

  // 成功：写缓存
  const data = result.data;
  const cache: LicenseCache = {
    token: data.token,
    expiresAt: data.expiresAt,
    machine,
    code: data.code,
    features: data.features,
    plan: data.plan,
  };
  await writeTokenCache(cache);

  return {
    status: "activated",
    code: cache.code,
    expiresAt: cache.expiresAt,
    features: cache.features,
    plan: cache.plan,
    machine,
  };
}

/**
 * API 路由的授权门卫（与 `auth.ts` 的 `requireAuth()` 同风格）。
 *
 * 返回值刻意设计成「未授权才返回值」：
 * 已激活/bypass 返回 null，调用方写成 `const blocked = await requireLicense(); if (blocked) return blocked;`
 *
 * 未激活返回 `Response.json({ error:'not_activated', code:'not_activated', message:'...' }, { status:403 })`。
 * 中文 message 要能直接显示给用户看。
 */
export async function requireLicense(): Promise<Response | null> {
  const state = await getLicenseState();
  if (state.status === "activated" || state.status === "bypass") return null;
  return Response.json(
    {
      error: "not_activated",
      code: "not_activated",
      message: "尚未激活授权，请在「设置 → 授权」中输入注册码激活。",
    },
    { status: 403 },
  );
}

/**
 * 判断是否拥有某个功能。
 *
 * `core` 恒有（协议 §3）；bypass 状态恒有所有功能。
 * 其他状态看 features 列表。
 */
export async function hasFeature(name: string): Promise<boolean> {
  const state = await getLicenseState();
  if (state.status === "bypass") return true;
  if (name === "core") return true;
  if (state.status === "activated" || state.status === "expired") {
    return state.features.includes(name);
  }
  return false;
}

/**
 * 给 UI 用的可序列化快照。
 *
 * - status：`activated` / `expired` / `missing` / `bypass`
 * - code：打码（只留前 4 与后 2），missing/bypass 时为 null
 * - expiresAt：毫秒时间戳，missing/bypass 时为 null
 * - daysLeft：剩余天数（向下取整），expired 为负数，missing/bypass 为 null
 * - features：功能列表（bypass 时返回 `["core"]` 占位）
 * - plan：套餐，missing/bypass 时为 null
 * - serverConfigured：`GAOTAI_LICENSE_SERVER` 是否已配置
 */
export async function licenseSnapshot(): Promise<LicenseSnapshot> {
  const state = await getLicenseState();
  const serverConfigured = resolveLicenseServer() !== null;

  if (state.status === "bypass") {
    return {
      status: "bypass",
      code: null,
      expiresAt: null,
      daysLeft: null,
      features: ["core"],
      plan: null,
      serverConfigured,
    };
  }

  if (state.status === "missing") {
    return {
      status: "missing",
      code: null,
      expiresAt: null,
      daysLeft: null,
      features: [],
      plan: null,
      serverConfigured,
    };
  }

  // activated / expired
  const daysLeft = Math.floor((state.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
  return {
    status: state.status,
    code: maskCode(state.code),
    expiresAt: state.expiresAt,
    daysLeft,
    features: state.features,
    plan: state.plan,
    serverConfigured,
  };
}

/**
 * 重置进程内缓存（供测试用）。
 *
 * 清掉进程内状态缓存 + 上次刷新时间，让下一次 `getLicenseState()` 重新读盘。
 */
export function resetLicenseCache(): void {
  procCache = null;
  lastRefreshAt = 0;
}
