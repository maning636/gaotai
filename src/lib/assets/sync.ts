import { createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../paths";
import { getLicenseState } from "../license/gate";
import { resolveLicenseServers } from "../license/server-url";
import { readTokenCache } from "../license/store";

/**
 * 资产同步：激活后从授权服务器加密下发四类只读资产，本机缓存。
 *
 * 这是授权体系防复刻的核心：技能包 / 提示词 / 专题 / 排版包**不进安装包**，
 * 用户拆包看不到。激活后客户端持 token 向授权服务器拉取，按协议 §5 派生
 * AES-256-GCM 密钥解密，落盘到 `<dataDir>/assets/root`。
 *
 * 协议：
 * - manifest：`GET /v1/assets/manifest`（Bearer token）→ `{ version, assets[] }`
 * - 每包：`GET /v1/assets/<name>?version=<manifest 里的版本>` → `{ name, version, plainSha256, iv, tag, data }`
 * - 解密后明文：`{ version, files: { "<相对路径>": "<base64 内容>" } }`
 * - 密钥派生：`hkdfSync("sha256", utf8(token), utf8("gaotai-asset-v1"), utf8(name+":"+version), 32)`
 *
 * 可靠性设计：
 * - 未激活（`getLicenseState()` 非 `activated`）→ `skipped`，不发任何请求。
 * - 已有本地缓存且目录齐全：非 `force` 直接 `ready`，不每次打服务器（离线友好）。
 * - `force: true` 才重新拉 manifest，版本一致且目录齐全则 `ready`。
 * - 下载先写临时目录，校验通过后整体替换 `root`；任何一步失败**保留旧缓存**，
 *   绝不删掉可用的旧缓存。
 * - 路径安全校验：拒绝 `..`、绝对路径、反斜杠、控制字符，防止服务端包在客户端写出目录外文件。
 * - 模块级互斥：并发多次调用只跑一次。
 */

/** 四类资产包名（协议 §4.5 固定）。 */
const ASSET_PACKS = ["skills", "prompts", "topics", "layout-packs"] as const;

/** 协议 §5：HKDF 盐固定。 */
const ASSET_SALT = "gaotai-asset-v1";

/** 每次请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 单个资产包在 state.json 里的记录。 */
export type AssetPackState = { version: string; sha256: string };

/** `<dataDir>/assets/state.json` 的结构。 */
export type AssetState = {
  version: string;
  packs: Record<string, AssetPackState>;
  /** 上次与服务端 manifest 比对的时间（毫秒）。老缓存没有这个字段，当作「很久没查」。 */
  checkedAt?: number;
};

/** ensureAssets 的返回值。 */
export type EnsureAssetsResult =
  | { status: "skipped" }
  | { status: "ready"; version: string }
  | { status: "updated"; version: string }
  | { status: "failed"; error: string };

/** 服务器 manifest 里单个资产条目的形状（协议 §4.4）。 */
type ManifestAsset = { name: string; version: string; bytes?: number; sha256?: string; url?: string };
type ManifestData = { version: string; assets: ManifestAsset[] };

/**
 * 隔多久回头问一次服务端「有没有新版资源」。
 *
 * 不能只在激活时比对：安装包装好后就不再激活了，同一天改的提示词永远到不了
 * 已经装好的人手里。6 小时一次、一次一个几百字节的 manifest，成本可以忽略。
 */
const ASSET_RECHECK_MS = 6 * 60 * 60 * 1000;

/** 资源清单文件路径。 */
export function assetStateFile(): string {
  return path.join(dataDir(), "assets", "state.json");
}

/** 下发后四类资产落盘的根目录（`root/skills/**` 这样的真实文件树）。 */
export function assetRootDir(): string {
  return path.join(dataDir(), "assets", "root");
}

/** 读取本地资源清单；不存在 / 坏结构返回 null。 */
export async function readAssetState(): Promise<AssetState | null> {
  try {
    const raw = await readFile(assetStateFile(), "utf8");
    const obj = JSON.parse(raw) as Partial<AssetState>;
    if (typeof obj.version === "string" && obj.packs && typeof obj.packs === "object") {
      return obj as AssetState;
    }
    return null;
  } catch {
    return null;
  }
}

/** 记下「刚和服务端比对过」，避免每次启动都拉 manifest。 */
async function touchCheckedAt(state: AssetState): Promise<void> {
  const file = assetStateFile();
  const next: AssetState = { ...state, checkedAt: Date.now() };
  const tmp = `${file}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await rm(file, { force: true });
    await rename(tmp, file);
  } catch {
    // 只是记个时间，写不进去不影响本次就绪判断。
  }
}

/** 下发资产当前本地状态（供 UI 展示）：`{ version, ready } | null`。 */
export async function assetLocalState(): Promise<{ version: string; ready: boolean } | null> {
  const state = await readAssetState();
  if (!state) return null;
  const ready = await packsPresent(assetRootDir(), Object.keys(state.packs));
  return { version: state.version, ready };
}

/**
 * 模块级互斥：并发多次调用共享同一次执行。
 * 第一个调用把 promise 存起来，后续调用直接复用；完成后清空。
 */
let inflight: Promise<EnsureAssetsResult> | null = null;

/**
 * 确保四类资产就绪。
 *
 * @param opts.force 强制重新拉 manifest 并比对；默认只信任本地缓存。
 * @returns `skipped` / `ready` / `updated` / `failed`。
 */
export function ensureAssets(opts?: { force?: boolean }): Promise<EnsureAssetsResult> {
  if (inflight) return inflight;
  const p = run(opts?.force ?? false).finally(() => {
    inflight = null;
  });
  inflight = p;
  return p;
}

/** ensureAssets 的实际执行体。 */
async function run(force: boolean): Promise<EnsureAssetsResult> {
  // 1. 未激活直接跳过，不发任何请求。
  let state;
  try {
    state = await getLicenseState();
  } catch (error) {
    return { status: "failed", error: `读取授权状态失败：${msg(error)}` };
  }
  if (state.status !== "activated") {
    return { status: "skipped" };
  }

  // 2. 本地缓存命中判断。
  const local = await readAssetState();
  const root = assetRootDir();
  const localOk = Boolean(local) && (await packsPresent(root, Object.keys(local!.packs)));
  const fresh =
    typeof local?.checkedAt === "number" && Date.now() - local.checkedAt < ASSET_RECHECK_MS;
  if (localOk && !force && fresh) {
    return { status: "ready", version: local!.version };
  }

  // 3. 取 token（HKDF 派生与 Bearer 头都用它）。
  const cache = await readTokenCache();
  if (!cache) {
    return { status: "failed", error: "找不到授权令牌，无法获取资源包，请重新激活。" };
  }
  const bases = serverBases();
  if (!bases.length) {
    return { status: "failed", error: "未配置授权服务器地址，无法获取资源包。" };
  }

  // 4. 拉 manifest。主地址连不上就换备用地址；哪条通了，后面整轮都用它。
  let manifest: ManifestData | null = null;
  let base = "";
  let lastError: unknown = null;
  for (const candidate of bases) {
    try {
      manifest = await fetchManifest(candidate, cache.token);
      base = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!manifest) {
    return { status: "failed", error: `拉取资源清单失败：${msg(lastError)}` };
  }
  // 版本一致且目录齐全 → 就绪，不下发；顺手把「刚查过」记下来。
  if (localOk && local!.version === manifest.version) {
    await touchCheckedAt(local!);
    return { status: "ready", version: local!.version };
  }

  // 5. 逐包下载 + 解密 + 校验。
  const filesByPack = new Map<string, Record<string, string>>();
  try {
    for (const asset of manifest.assets) {
      const pack = await fetchPack(base, asset, cache.token);
      filesByPack.set(asset.name, pack.files);
    }
  } catch (error) {
    return { status: "failed", error: `资源包下载失败：${msg(error)}` };
  }

  // 6. 落盘（临时目录 → 整体替换；失败保留旧缓存）。
  try {
    await applyDownload(manifest, filesByPack);
  } catch (error) {
    return { status: "failed", error: `资源包落盘失败：${msg(error)}` };
  }

  return { status: "updated", version: manifest.version };
}

/** 授权服务器地址列表（去尾斜杠），按优先级排列。 */
function serverBases(): string[] {
  return resolveLicenseServers();
}

/** 从 package.json 读版本（读不到用 0.0.0 兜底），只用于 User-Agent。 */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 带 Bearer 的 GET，解析协议信封，非 2xx / 信封失败抛 Error（中文）。 */
async function fetchJson(url: string, token: string): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": `gaotai/${appVersion()}`,
        "X-Gaotai-App": appVersion(),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`连不上授权服务器（${msg(error)}）`, { cause: error });
  }

  let text: string;
  try {
    text = await resp.text();
  } catch {
    throw new Error("无法读取授权服务器响应。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("授权服务器返回了无法解析的内容。");
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error("授权已失效，请重新激活后再同步。");
  }
  const env = parsed as { ok?: unknown; data?: unknown; error?: { message?: unknown } };
  if (env.ok === true && env.data && typeof env.data === "object") {
    return env.data as Record<string, unknown>;
  }
  const serverMsg = env.error?.message;
  throw new Error(typeof serverMsg === "string" ? serverMsg : `授权服务器返回错误（HTTP ${resp.status}）。`);
}

/** 拉取资产清单（协议 §4.4）。 */
async function fetchManifest(base: string, token: string): Promise<ManifestData> {
  const data = await fetchJson(`${base}/v1/assets/manifest`, token);
  if (typeof data.version !== "string" || !Array.isArray(data.assets)) {
    throw new Error("资源清单格式不正确。");
  }
  return data as unknown as ManifestData;
}

/** 协议 §5：从 token 派生资产密钥。 */
function deriveAssetKey(token: string, name: string, version: string): Buffer {
  const ikm = Buffer.from(token, "utf8");
  const salt = Buffer.from(ASSET_SALT, "utf8");
  const info = Buffer.from(`${name}:${version}`, "utf8");
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
}

/** 下载并解密单个资产包，校验 sha256 后返回明文文件映射。 */
async function fetchPack(
  base: string,
  asset: ManifestAsset,
  token: string,
): Promise<{ version: string; files: Record<string, string> }> {
  const url = `${base}/v1/assets/${encodeURIComponent(asset.name)}?version=${encodeURIComponent(asset.version)}`;
  const data = await fetchJson(url, token);
  if (
    typeof data.name !== "string" ||
    typeof data.version !== "string" ||
    typeof data.plainSha256 !== "string" ||
    typeof data.iv !== "string" ||
    typeof data.tag !== "string" ||
    typeof data.data !== "string"
  ) {
    throw new Error(`资源包 ${asset.name} 数据不完整。`);
  }

  const key = deriveAssetKey(token, data.name, data.version);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(data.iv, "base64"));
    decipher.setAuthTag(Buffer.from(data.tag, "base64"));
    plain = Buffer.concat([decipher.update(Buffer.from(data.data, "base64")), decipher.final()]);
  } catch (error) {
    throw new Error(`资源包 ${data.name} 解密失败（密钥或密文不正确）：${msg(error)}`, { cause: error });
  }

  const sha = createHash("sha256").update(plain).digest("hex");
  if (sha !== data.plainSha256) {
    throw new Error(`资源包 ${data.name} 校验失败（sha256 不匹配）。`);
  }

  let pack: { version?: unknown; files?: unknown };
  try {
    pack = JSON.parse(plain.toString("utf8")) as { version?: unknown; files?: unknown };
  } catch {
    throw new Error(`资源包 ${data.name} 明文不是合法 JSON。`);
  }
  if (typeof pack.version !== "string" || !pack.files || typeof pack.files !== "object") {
    throw new Error(`资源包 ${data.name} 明文格式不正确。`);
  }
  return { version: pack.version, files: pack.files as Record<string, string> };
}

/**
 * 路径安全校验：拒绝绝对路径、`..`、反斜杠、空段与控制字符。
 * 返回拼在 root 下的绝对路径。
 */
function safeJoin(root: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new Error(`非法资源路径：空路径`);
  }
  if (rel.includes("\\")) {
    throw new Error(`非法资源路径：${rel}`);
  }
  // eslint-disable-next-line no-control-regex -- 控制字符（含 NUL）不允许出现在文件路径里
  if (/[\u0000-\u001f\u007f]/.test(rel)) {
    throw new Error(`非法资源路径：${rel}`);
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`非法资源路径：${rel}`);
  }
  const parts = rel.split("/");
  for (const part of parts) {
    if (part === ".." || part === "") {
      throw new Error(`非法资源路径：${rel}`);
    }
  }
  const resolved = path.resolve(root, ...parts);
  if (path.relative(root, resolved).startsWith("..")) {
    throw new Error(`非法资源路径：${rel}`);
  }
  return resolved;
}

/** 检查 root 下指定包名的目录是否都存在（目录缺失视为未就绪）。 */
async function packsPresent(root: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    try {
      const st = await stat(path.join(root, name));
      if (!st.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 把下载好的全部包写到临时目录，再整体替换 `root`。
 *
 * 替换策略（Windows 上 rename 不能覆盖非空目录）：
 * 1. 先把旧 root rename 成 `.old-*`（仅当存在）；
 * 2. 再把临时目录 rename 成 root；
 * 3. 若第 2 步失败，把 `.old-*` 改回 root，保留旧缓存；
 * 4. 成功后删除 `.old-*`。
 */
async function applyDownload(
  manifest: ManifestData,
  filesByPack: Map<string, Record<string, string>>,
): Promise<void> {
  const assetsDir = path.dirname(assetRootDir());
  await mkdir(assetsDir, { recursive: true });

  const tmp = path.join(assetsDir, `.tmp-${randomBytes(8).toString("hex")}`);
  await mkdir(tmp, { recursive: true });
  try {
    for (const files of filesByPack.values()) {
      for (const [rel, b64] of Object.entries(files)) {
        const dest = safeJoin(tmp, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, Buffer.from(b64, "base64"));
      }
    }

    const root = assetRootDir();
    const backup = path.join(assetsDir, `.old-${randomBytes(8).toString("hex")}`);
    let backedUp = false;
    if (existsSync(root)) {
      await rename(root, backup);
      backedUp = true;
    }
    try {
      await rename(tmp, root);
    } catch (error) {
      if (backedUp) {
        try {
          await rename(backup, root);
        } catch {
          // 还原失败也不掩盖原始错误；旧缓存可能已不可用，交由上层报错。
        }
      }
      throw error;
    }
    if (backedUp) {
      try {
        await rm(backup, { recursive: true, force: true });
      } catch {
        // 清不掉备份不致命，留待下次覆盖。
      }
    }
  } catch (error) {
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // 清理失败不掩盖原始错误。
    }
    throw error;
  }

  // root 已就位，写 state.json（尽力而为：写失败则下次重新下发，不视为整体失败）。
  try {
    await writeAssetState(manifest);
  } catch (error) {
    console.warn("[gaotai/assets] 资源清单写入失败（下次会重新同步）：", msg(error));
  }
}

/** 原子写 `<dataDir>/assets/state.json`。 */
async function writeAssetState(manifest: ManifestData): Promise<void> {
  const file = assetStateFile();
  const state: AssetState = { version: manifest.version, packs: {}, checkedAt: Date.now() };
  for (const a of manifest.assets) {
    state.packs[a.name] = { version: a.version, sha256: a.sha256 ?? "" };
  }
  const tmp = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  try {
    await rm(file, { force: true });
  } catch {
    // 目标不存在，忽略。
  }
  await rename(tmp, file);
}

/** 错误转字符串。 */
function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 保留 ASSET_PACKS 引用：四类包名是协议常量，供将来校验/扩展使用。
export { ASSET_PACKS };
