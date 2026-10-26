import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataStorageDir, loginFailuresFile } from "./paths";

/**
 * 登录失败审计。
 *
 * 桌面客户端跑在用户自己机器上，理论上只有本机能访问；但仍然要留一份失败记录：
 * 一是排查"我明明输了密码为什么进不去"，二是万一端口被别的进程占用、
 * 页面被别人打开过，日志里能看出来。
 *
 * 记录只存时间、来源地址和 UA，不存任何口令尝试内容。
 */

export type LoginFailure = {
  /** 毫秒时间戳。 */
  at: number;
  /** 来源地址。 */
  ip: string;
  /** 浏览器 UA 摘要。 */
  ua: string;
};

const MAX_RECORDS = 200;

/** 取来源地址。Electron 壳访问本机时是 127.0.0.1。 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") || "127.0.0.1";
}

function userAgent(request: Request): string {
  const ua = request.headers.get("user-agent") || "";
  return ua.length > 200 ? `${ua.slice(0, 200)}…` : ua;
}

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(loginFailuresFile()), { recursive: true });
}

/** 追加一条失败记录，并裁剪到最近 MAX_RECORDS 条。 */
export async function recordLoginFailure(request: Request): Promise<LoginFailure> {
  const entry: LoginFailure = {
    at: Date.now(),
    ip: clientAddress(request),
    ua: userAgent(request),
  };
  await ensureDir();
  await appendFile(loginFailuresFile(), `${JSON.stringify(entry)}\n`, "utf8");

  // 裁剪：读回来只留尾部，超长就直接重写。
  try {
    const raw = await readFile(loginFailuresFile(), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_RECORDS) {
      await writeFile(loginFailuresFile(), `${lines.slice(-MAX_RECORDS).join("\n")}\n`, "utf8");
    }
  } catch {
    // 裁剪失败不影响主流程：失败记录本身已经写进去了。
  }
  return entry;
}

/** 读最近的失败记录。 */
export async function listLoginFailures(limit = 100): Promise<LoginFailure[]> {
  try {
    const raw = await readFile(loginFailuresFile(), "utf8");
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as LoginFailure;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is LoginFailure => entry !== null);
    return entries.slice(-Math.max(1, Math.min(limit, MAX_RECORDS))).reverse();
  } catch {
    return [];
  }
}

/** 最近 windowMs 毫秒内的失败次数。 */
export async function countRecentFailures(windowMs = 10 * 60 * 1000): Promise<number> {
  const since = Date.now() - windowMs;
  const entries = await listLoginFailures(MAX_RECORDS);
  return entries.filter(entry => entry.at >= since).length;
}

/** 数据目录是否可用（首次运行时可能还没建）。 */
export async function ensureDataDir(): Promise<string> {
  await ensureDir();
  return dataStorageDir();
}
