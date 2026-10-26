import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dataStorageDir, envFile } from "./paths";

/**
 * 首次运行的运行时引导。
 *
 * 桌面客户端没有可编辑的 .env：密钥、登录密码与会话密钥必须由程序生成。
 * 生成规则：
 * - SESSION_SECRET：32 字节随机十六进制，用于签发会话与派生 LM 密钥的加密口令。
 * - APP_PASSWORD：12 字节随机十六进制，作为应用登录密码，同时写入 initial-password.txt。
 * - DEEPSEEK_API_KEY：留空，由用户在「LM 配置」页面填写。
 *
 * initial-password.txt 让 Electron 可以在启动时自动完成登录，用户不必每次手动输入。
 * 该文件读取后即删除，避免密码长期留在磁盘。
 */

const PASSWORD_FILE = "initial-password.txt";

function randomHex(bytes: number) {
  return randomBytes(bytes).toString("hex");
}

export type RuntimeEnv = {
  /** 本次调用是否新建了 .env。 */
  created: boolean;
  /** 新建时生成的应用密码；已存在时为空。 */
  password: string;
  envPath: string;
};

export async function ensureRuntimeEnv(): Promise<RuntimeEnv> {
  const envPath = envFile();

  // 先把已有的 .env 读进进程环境，再决定要不要补齐缺失项。
  // 顺序不能反：登录口令与会话密钥必须先在 process.env 里就位，
  // 否则启动窗口内任何一次登录/签发都会失败。
  loadEnvIntoProcess(envPath);

  if (existsSync(envPath)) {
    // .env 已存在但不完整（例如手工创建时漏了 SESSION_SECRET）时补齐缺失项，
    // 否则登录接口会一直返回「尚未配置」。
    const patched = await patchIncompleteEnv(envPath);
    if (!patched) return { created: false, password: "", envPath };
    loadEnvIntoProcess(envPath);
    const password = await readGeneratedPassword(envPath);
    if (password) await writePasswordFile(password);
    return { created: true, password, envPath };
  }
  const password = randomHex(12);
  const content = [
    "# 由桌面客户端首次运行时自动生成，请勿提交到版本库。",
    "DEEPSEEK_API_KEY=",
    "DEEPSEEK_BASE_URL=https://api.deepseek.com",
    `APP_PASSWORD=${password}`,
    `SESSION_SECRET=${randomHex(32)}`,
    "AUTH_COOKIE_SECURE=false",
    "",
  ].join("\n");
  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(envPath, content, { encoding: "utf8", mode: 0o600 });
  await writePasswordFile(password);
  loadEnvIntoProcess(envPath);
  return { created: true, password, envPath };
}

// 补齐 .env 中缺失的登录必需项；返回是否真的改动了文件。
async function patchIncompleteEnv(envPath: string): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises");
    const original = await readFile(envPath, "utf8");
    const has = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*\\S`, "m").test(original);
    const missing: string[] = [];
    if (!has("APP_PASSWORD")) missing.push(`APP_PASSWORD=${randomHex(12)}`);
    if (!has("SESSION_SECRET")) missing.push(`SESSION_SECRET=${randomHex(32)}`);
    if (!missing.length) return false;
    await writeFile(envPath, `${original.replace(/\s*$/, "")}\n${missing.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// 补齐场景下也要把密码交给客户端，让 Electron 能自动登录。
async function readGeneratedPassword(envPath: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(envPath, "utf8");
    const match = raw.match(/^\s*(?:export\s+)?APP_PASSWORD\s*=\s*(.+?)\s*$/m);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

/** 供 Electron 启动时读取并自动登录；读取后立即删除文件。 */
export async function readInitialPassword(): Promise<string> {
  const file = path.join(dataStorageDir(), PASSWORD_FILE);
  if (!existsSync(file)) return "";
  try {
    const { readFile, unlink } = await import("node:fs/promises");
    const password = (await readFile(file, "utf8")).trim();
    await unlink(file);
    return password;
  } catch {
    return "";
  }
}

async function writePasswordFile(password: string) {
  const file = path.join(dataStorageDir(), PASSWORD_FILE);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, password, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600).catch(() => {
      // Windows 不支持 POSIX 权限位，忽略即可。
    });
  } catch (error) {
    // 写不出密码文件意味着桌面客户端无法自动登录，必须显式记录而不是静默失败。
    console.error("[gaotai] 写入初始密码文件失败：", error);
  }
}

/**
 * 把 .env 里的键读进 process.env。
 *
 * 必须显式做这件事：Next 只在**启动时**从项目根读 .env，
 * 而桌面版的 .env 是首次运行时才生成的（生成时进程早就起来了），
 * 打包态的 cwd 还是 standalone 目录，Next 根本找不到用户数据目录里的 .env。
 * 不补这一步，process.env.APP_PASSWORD / SESSION_SECRET 全是空的，
 * 表现是登录接口永远不认口令、会话签发直接抛错。
 *
 * 已存在的环境变量优先，不覆盖：启动方显式注入的值比文件里的更权威。
 */
export function loadEnvIntoProcess(envPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2] ?? "";
    // 去掉行尾注释（仅当引号外出现 # 时）。
    if (!/^(['"]).*\1$/.test(value)) {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    value = value.replace(/^(['"])([\s\S]*)\1$/, "$2");
    process.env[key] = value;
  }
}
