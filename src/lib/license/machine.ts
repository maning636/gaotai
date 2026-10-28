import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { dataDir } from "../paths";

/**
 * 机器码计算（协议 §2）。
 *
 * ```
 * material = "gaotai-v1|" + hardId + "|" + diskSerial
 * machine  = sha256(material)
 * ```
 *
 * hardId 逐级降级：Win32_ComputerSystemProduct.UUID → MachineGuid → os.hostname()。
 * diskSerial 取第一块物理磁盘序列号，取不到用空串。
 *
 * 结果缓存到 `<dataDir>/.license/machine`，避免每次启动都跑 PowerShell。
 * 读取缓存时校验 `^[0-9a-f]{64}$`，不合法就重算。
 *
 * Windows 取值用 `powershell.exe -NoProfile -NonInteractive -Command`，超时 4 秒。
 * 失败逐级降级，不抛错——机器码取不到也得给一个稳定值，不能让应用起不来。
 */

/** 机器码缓存文件路径。 */
export function machineCacheFile(): string {
  return path.join(dataDir(), ".license", "machine");
}

/** powershell 取值用的超时，毫秒。 */
const PS_TIMEOUT_MS = 4000;

/** 合法机器码：64 位小写十六进制。 */
const MACHINE_RE = /^[0-9a-f]{64}$/;

/**
 * 跑一段 PowerShell，拿 stdout（去首尾空白）。
 *
 * 失败（非零退出、超时、没输出）一律返回空串，不抛错——
 * 调用方靠降级链兜底，不能因为 PowerShell 取不到就让应用崩。
 */
function ps(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: PS_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve("");
          return;
        }
        resolve((stdout || "").trim());
      },
    );
  });
}

/** 取 Win32_ComputerSystemProduct.UUID（降级第一级）。 */
async function readUuidDefault(): Promise<string> {
  return ps("(Get-CimInstance Win32_ComputerSystemProduct).UUID");
}

/** 取注册表 MachineGuid（降级第二级）。 */
async function readMachineGuidDefault(): Promise<string> {
  return ps("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid");
}

/** 取第一块物理磁盘序列号（取不到用空串）。 */
async function readDiskSerialDefault(): Promise<string> {
  return ps("(Get-CimInstance Win32_DiskDrive | Select-Object -First 1).SerialNumber");
}

/**
 * 可注入的取值接口。
 *
 * 测试里绝不真的跑 PowerShell：直接传桩函数返回假读数，
 * 验证降级链、稳定性、换盘变码等行为。
 */
export interface MachineReaders {
  readUuid: () => Promise<string>;
  readMachineGuid: () => Promise<string>;
  readDiskSerial: () => Promise<string>;
  hostname: () => string;
}

/** 生产环境的取值实现（真的跑 PowerShell）。 */
const defaultReaders: MachineReaders = {
  readUuid: readUuidDefault,
  readMachineGuid: readMachineGuidDefault,
  readDiskSerial: readDiskSerialDefault,
  hostname: () => hostname(),
};

/**
 * 从取值接口拼出 hardId：UUID → MachineGuid → hostname。
 *
 * 每一级只在上一级为空时启用；三级都空就回退到 hostname（一定有值）。
 */
async function resolveHardId(readers: MachineReaders): Promise<string> {
  if (process.platform === "win32") {
    const uuid = await readers.readUuid();
    if (uuid) return uuid;
    const guid = await readers.readMachineGuid();
    if (guid) return guid;
  }
  // 非 Windows 或 Windows 两级都取不到：用 hostname + 平台名兜底。
  return `${readers.hostname()}-${process.platform}`;
}

/**
 * 按协议 §2 计算机器码。
 *
 * 纯函数：不碰缓存、不碰 IO，只依赖传入的 readers。
 * 测试直接调它，断言稳定 / 换盘变 / 降级路径。
 */
export async function computeMachineId(readers: MachineReaders): Promise<string> {
  const hardId = await resolveHardId(readers);
  const diskSerial = process.platform === "win32" ? await readers.readDiskSerial() : "";
  const material = `gaotai-v1|${hardId}|${diskSerial}`;
  return createHash("sha256").update(material).digest("hex");
}

/**
 * 读缓存文件里的机器码；不存在或格式非法返回 null。
 *
 * 缓存文件内容就是机器码本身（一行 64 位 hex）。
 */
function readMachineCache(file: string): string | null {
  try {
    const v = readFileSync(file, "utf8").trim();
    return MACHINE_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 把机器码写进缓存文件（原子写：临时文件 + rename）。
 *
 * Windows 上 rename 覆盖已存在文件可能失败，先 unlink 目标再 rename；
 * 目标不存在忽略。全程不抛错——缓存写不进去不影响机器码本身。
 */
function writeMachineCache(file: string, machine: string): void {
  const dir = path.dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 目录建不起来就没法缓存，但机器码本身已经算出来了，不阻塞。
    return;
  }
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, machine, "utf8");
  } catch {
    // 写临时文件失败，放弃缓存。
    return;
  }
  // Windows 上 rename 到已存在文件会失败：先删目标，再 rename。
  try {
    unlinkSync(file);
  } catch {
    // 目标不存在，忽略。
  }
  try {
    renameSync(tmp, file);
  } catch {
    // 最后还是写不进去，清理临时文件后放弃。
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

/**
 * 取本机机器码（带缓存）。
 *
 * 流程：读缓存 → 合法则用 → 不合法则重算并写缓存。
 * 缓存文件路径来自 `machineCacheFile()`，受 `GAOTAI_DATA_DIR` 影响（测试用临时目录）。
 */
export async function getMachineId(readers: MachineReaders = defaultReaders): Promise<string> {
  const file = machineCacheFile();
  const cached = existsSync(file) ? readMachineCache(file) : null;
  if (cached) return cached;

  const machine = await computeMachineId(readers);
  if (MACHINE_RE.test(machine)) {
    writeMachineCache(file, machine);
  }
  return machine;
}

/**
 * 重置机器码缓存文件（删掉）。
 *
 * 供测试用：每个用例清掉缓存，避免互相干扰。
 */
export function resetMachineCache(): void {
  try {
    unlinkSync(machineCacheFile());
  } catch {
    // 文件不存在就算了。
  }
}

/** 默认的 readers，导出供测试对照（测试一般传自己的桩）。 */
export { defaultReaders };
