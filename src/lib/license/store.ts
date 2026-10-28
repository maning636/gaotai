import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../paths";
import type { LicenseCache } from "./types";

/**
 * 授权缓存文件读写（协议 §7）。
 *
 * 缓存 `<dataDir>/.license/token.json`：`{ token, expiresAt, machine, code, features, plan }`。
 *
 * 写入：mkdir -p + 临时文件 + rename（原子）。Windows 上 rename 覆盖已存在文件可能失败，
 * 用 unlink 目标后 rename 重试。权限尽力设 0600（Windows 上拿不到就忽略，不报错）。
 *
 * 读取：文件不存在 / JSON 坏一律返回 null，不抛错——坏缓存不能让应用起不来。
 * 不做 token 验签（那是 gate 的活），只管序列化与原子落盘。
 */

/** 缓存目录路径。 */
export function licenseDir(): string {
  return path.join(dataDir(), ".license");
}

/** 缓存文件路径。 */
export function tokenCacheFile(): string {
  return path.join(licenseDir(), "token.json");
}

/**
 * 读缓存。
 *
 * 文件不存在、JSON 坏、结构不完整都返回 null。绝不抛错：
 * 缓存坏了大不了重新激活，不能让应用起不来。
 */
export async function readTokenCache(): Promise<LicenseCache | null> {
  const file = tokenCacheFile();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Partial<LicenseCache>;
    // 字段完整性：缺任一关键字段视为坏缓存。
    if (
      typeof obj.token !== "string" ||
      typeof obj.expiresAt !== "number" ||
      typeof obj.machine !== "string" ||
      typeof obj.code !== "string" ||
      !Array.isArray(obj.features) ||
      typeof obj.plan !== "string"
    ) {
      return null;
    }
    return obj as LicenseCache;
  } catch {
    return null;
  }
}

/**
 * 原子写缓存。
 *
 * 1. mkdir -p 目录
 * 2. 写临时文件 `<file>.tmp`
 * 3. 尽力 chmod 0600（Windows 上拿不到忽略）
 * 4. unlink 目标（不存在忽略）→ rename 临时文件到目标
 *
 * 任何步骤失败都不抛错：缓存写不进去不致命，下次启动会重算/重激活。
 * 但会返回 boolean 让调用方知道是否落盘成功（用于刷新流程的日志）。
 */
export async function writeTokenCache(cache: LicenseCache): Promise<boolean> {
  const file = tokenCacheFile();
  const dir = licenseDir();
  const tmp = `${file}.tmp`;

  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return false;
  }

  try {
    await writeFile(tmp, JSON.stringify(cache), "utf8");
  } catch {
    return false;
  }

  // 尽力设 0600。Windows 上 chmod 不生效但不报错（Node 的 fs.chmod 在 Windows 上是 no-op-ish）。
  try {
    await chmod(tmp, 0o600);
  } catch {
    // 拿不到就忽略，不报错。
  }

  // Windows 上 rename 到已存在文件会失败：先删目标。
  try {
    await unlink(file);
  } catch {
    // 目标不存在，忽略。
  }

  try {
    await rename(tmp, file);
    return true;
  } catch {
    // 最后还是写不进去，清理临时文件。
    try {
      await unlink(tmp);
    } catch {
      // ignore
    }
    return false;
  }
}

/**
 * 删除缓存文件。
 *
 * 供激活/刷新失败后清掉坏缓存，或测试用。
 */
export async function deleteTokenCache(): Promise<void> {
  try {
    await unlink(tokenCacheFile());
  } catch {
    // 不存在就算了。
  }
}
