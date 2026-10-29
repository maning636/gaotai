import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths";
import { resolveLicenseServers } from "./license/server-url";

/**
 * 应用版本更新检查（与授权门禁正交的一步）。
 *
 * 启动时问一次授权服务器的 `/v1/app/policy`，被判定必须更新（`blocked`）时由
 * 调用方锁页。这里只负责「问一次 + 缓存 + 失败放行」，不负责渲染。
 *
 * 关键约束：**任何失败都必须返回 null（不拦）**。这个检查永远不能把应用锁死：
 * 网络不通、服务端 500、返回非 JSON、版本号非法，都当成「没有更新策略」，
 * 让应用照常启动。宁可漏掉一次更新提示，也不能让用户打不开软件。
 *
 * 三层取值顺序（越快越省）：
 * 1. 进程内内存缓存（6 小时）——避免每次 API 调用都重新走网络；
 * 2. 磁盘缓存 `<dataDir>/cache/app-policy.json`（7 天）——跨启动复用；
 * 3. 网络请求——每次成功都原子落盘，失败不写、不覆盖旧缓存。
 *
 * `force: true` 跳过全部缓存，强制走网络（「我已更新，重新检查」按钮）。
 */

/** 当前版本。打包时由 next.config.ts 注入 NEXT_PUBLIC_APP_VERSION，取不到用 0.0.0。 */
export const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

/** 服务端返回的版本策略（与 `/v1/app/policy` 的 `data` 字段一一对应）。 */
export type AppPolicy = {
  latest: string;
  minSupported: string;
  mode: "link" | "direct";
  url: string;
  notes: string;
  blocked: boolean;
  current: string;
};

/** 进程内缓存 TTL：6 小时。 */
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000;

/** 磁盘缓存有效期：7 天。超过视为无效，下次启动重新问服务端。 */
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 网络超时：5 秒。更新检查是启动路径的一部分，不能让它拖慢首屏。 */
const NETWORK_TIMEOUT_MS = 5000;

/** 磁盘缓存文件的存放目录。 */
function cacheDir(): string {
  return path.join(dataDir(), "cache");
}

/** 磁盘缓存文件路径。 */
export function appPolicyCacheFile(): string {
  return path.join(cacheDir(), "app-policy.json");
}

/** 磁盘缓存文件的落盘结构（带写入时间，用于判断 7 天过期）。 */
type DiskCache = {
  fetchedAt: number;
  policy: AppPolicy;
};

let memoryCache: { fetchedAt: number; policy: AppPolicy } | null = null;

/**
 * 语义化版本比较（支持 `1.0` 与 `1.0.0` 等价、`0.10.0 > 0.9.0`）。
 *
 * 返回 1 / -1 / 0；任一参数不是合法语义化版本（三个数字段）时返回 null。
 * 服务端版本号可能带 `v` 前缀或尾随构建号，这里只认「纯数字点分」的头部三段。
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (raw: string): number[] | null => {
    // 去 `v` 前缀与首尾空白；构建元数据（如 `1.0.0+build1`）按纯数字段截断。
    const cleaned = raw.trim().replace(/^v/i, "").split(/[+ -]/)[0];
    const parts = cleaned.split(".");
    if (parts.length < 1 || parts.length > 3) return null;
    const nums: number[] = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return null;
      nums.push(Number(part));
    }
    // 补齐到三段，让 `1.0` 与 `1.0.0` 等价。
    while (nums.length < 3) nums.push(0);
    return nums;
  };

  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;

  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * 校验一个未知对象是不是合法的 AppPolicy。
 *
 * 只把「决定要不要拦」的关键字段当硬校验：`blocked`、`latest`、`current`、`url`。
 * `mode`/`notes`/`minSupported` 是展示用字段，缺了就给默认值——
 * 服务端偶尔少发一个字段不该让整条策略作废，否则会把「该拦」误判成「不拦」。
 */
function isAppPolicy(value: unknown): value is AppPolicy {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.latest === "string" &&
    typeof p.current === "string" &&
    typeof p.url === "string" &&
    typeof p.blocked === "boolean"
  );
}

/** 把一个未知对象规整成 AppPolicy（缺省字段补默认值；非法返回 null）。 */
function coercePolicy(value: unknown): AppPolicy | null {
  if (!isAppPolicy(value)) return null;
  const p = value as Record<string, unknown>;
  const mode = p.mode === "direct" ? "direct" : "link";
  return {
    latest: p.latest as string,
    minSupported: typeof p.minSupported === "string" ? p.minSupported : "0.0.0",
    mode,
    url: p.url as string,
    notes: typeof p.notes === "string" ? p.notes : "",
    blocked: p.blocked as boolean,
    current: p.current as string,
  };
}

/** 原子写磁盘缓存（临时文件 + rename）。任何失败静默：缓存写不进不致命。 */
async function writeDiskCache(policy: AppPolicy): Promise<void> {
  const file = appPolicyCacheFile();
  const tmp = `${file}.tmp`;
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(tmp, JSON.stringify({ fetchedAt: Date.now(), policy }), "utf8");
    // Windows 上 rename 覆盖已存在文件会失败，先删目标。
    try {
      await unlink(file);
    } catch {
      // 目标不存在，忽略。
    }
    await rename(tmp, file);
  } catch {
    // 写不进去就忽略：下次启动会重算。
    try {
      await unlink(tmp);
    } catch {
      // ignore
    }
  }
}

/** 读磁盘缓存；不存在、坏 JSON、结构不对、超 7 天，都返回 null。 */
async function readDiskCache(): Promise<AppPolicy | null> {
  let raw: string;
  try {
    raw = await readFile(appPolicyCacheFile(), "utf8");
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Partial<DiskCache>;
    if (typeof obj.fetchedAt !== "number" || !isAppPolicy(obj.policy)) return null;
    // 盘上缓存超过 7 天视为无效：版本策略会变，老缓存会误锁用户。
    if (Date.now() - obj.fetchedAt > DISK_TTL_MS) return null;
    return obj.policy;
  } catch {
    return null;
  }
}

/**
 * 向单个服务器地址发一次 `/v1/app/policy` 请求。
 *
 * 返回 `{ kind: "ok", policy }` 或 `{ kind: "unreachable" }` / `{ kind: "bad" }`。
 * 只有「连不上/超时」才是 `unreachable`（调用方据此换下一个地址）；
 * 服务器明确回了 4xx/5xx 或非 JSON，说明这条通路是通的，再换地址也一样。
 */
async function fetchPolicyFrom(base: string): Promise<
  { kind: "ok"; policy: AppPolicy } | { kind: "unreachable" } | { kind: "bad" }
> {
  const url = `${base}/v1/app/policy?version=${encodeURIComponent(CURRENT_VERSION)}&platform=win32`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      headers: { "User-Agent": `gaotai/${CURRENT_VERSION}` },
    });
  } catch {
    // 连不上 / DNS 失败 / 超时：换下一个地址。
    return { kind: "unreachable" };
  }

  // 服务端故意让「版本缺失/非法」返回 blocked:false，但仍可能是 200 + 合法信封。
  // 这里只要 HTTP 非 2xx 就当成「这条通路不可信」，整体不拦。
  if (!resp.ok) return { kind: "bad" };

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    // 非 JSON：不拦。
    return { kind: "bad" };
  }

  // 信封校验：{ ok: true, data: {...} }。
  const env = parsed as { ok?: unknown; data?: unknown };
  if (env?.ok !== true) return { kind: "bad" };
  const policy = coercePolicy(env.data);
  if (!policy) return { kind: "bad" };
  return { kind: "ok", policy };
}

/**
 * 检查是否需要更新。
 *
 * @param options.force 跳过内存与磁盘缓存，强制走网络（「重新检查」按钮用）。
 * @param options.allowNetwork 是否允许发起真实网络请求。默认 true；
 *   传 false 时即使缓存过期也只返回缓存（或 null），供限流后的调用方使用。
 * @returns 版本策略；任何失败（网络、超时、非 JSON、版本号非法、无配置服务器）返回 null。
 */
export async function checkForUpdate(options?: {
  force?: boolean;
  allowNetwork?: boolean;
}): Promise<AppPolicy | null> {
  const force = options?.force === true;
  const allowNetwork = options?.allowNetwork !== false;

  // 1. 内存缓存命中（非 force 时直接返回）。
  //    force 也要先看一眼内存缓存：网络被限流时至少能把「已知策略」交回去，
  //    而不是让「重新检查」按钮拿到 null 误判成「没有更新」。
  const freshMemory = memoryCache && Date.now() - memoryCache.fetchedAt < MEMORY_TTL_MS;
  if (!force && freshMemory) return memoryCache!.policy;

  // 2. 磁盘缓存命中（非 force 时；内存未命中或已过期才读盘）。
  if (!force) {
    const disk = await readDiskCache();
    if (disk) {
      memoryCache = { fetchedAt: Date.now(), policy: disk };
      return disk;
    }
  }

  // 3. 网络被限流：不发起请求。force 时回退到内存/磁盘里已有的策略，
  //    否则返回 null（首次就没有网络机会时只能当作「不拦」）。
  if (!allowNetwork) {
    if (force && memoryCache) return memoryCache.policy;
    if (force) {
      const disk = await readDiskCache();
      if (disk) return disk;
    }
    return null;
  }

  // 4. 网络请求：依次尝试主备地址，只有「连不上」才换下一个。
  const servers = resolveLicenseServers();
  for (const base of servers) {
    const result = await fetchPolicyFrom(base);
    if (result.kind === "ok") {
      memoryCache = { fetchedAt: Date.now(), policy: result.policy };
      // 落盘失败不影响结论（下次启动重新问服务端即可）。
      await writeDiskCache(result.policy);
      return result.policy;
    }
    if (result.kind === "bad") break; // 服务器明确回了错误，换地址没有意义。
    // unreachable：继续试下一个。
  }

  // 没有配置服务器，或全部连不上/回错：一律不拦。
  return null;
}

/**
 * 仅用于测试：清掉进程内缓存，让下一次 `checkForUpdate` 重新走网络/磁盘。
 */
export function resetAppUpdateCache(): void {
  memoryCache = null;
}
