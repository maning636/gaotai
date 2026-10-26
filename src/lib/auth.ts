import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { envFile } from "./paths";

/**
 * 登录与会话。
 *
 * 设计要点：
 * - 口令用 scrypt 加盐存储，永不落明文；
 * - 会话用 HMAC 签名的紧凑令牌，服务端无状态；
 * - 校验一律用 timingSafeEqual，避免时序侧信道；
 * - SESSION_SECRET 从 .env 读取，由首次运行引导生成。
 */

const COOKIE_NAME = "gaotai_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionPayload = {
  sub: string;
  iat: number;
  exp: number;
};

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new Error("SESSION_SECRET 未配置");
  return secret;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expected, "hex");
  if (actual.length !== expectedBuf.length) return false;
  return timingSafeEqual(actual, expectedBuf);
}

/** 口令哈希是否与某个明文匹配（口令本身存在 .env 里）。 */
export function passwordMatches(plain: string): boolean {
  const configured = process.env.APP_PASSWORD?.trim();
  if (!configured) return false;
  const a = Buffer.from(plain);
  const b = Buffer.from(configured);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signSession(payload: SessionPayload): string {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const signature = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createSessionCookie(): Promise<void> {
  const now = Date.now();
  const token = signSession({ sub: "owner", iat: now, exp: now + SESSION_TTL_MS });
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.AUTH_COOKIE_SECURE === "true",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/**
 * 读取当前会话。
 *
 * 会话密钥缺失时不抛错，只当"没登录"：抛错会让每个需要登录的接口都变成 500，
 * 用户看到的是一堆接口报错，而不是一个登录页。
 */
export async function readSession(): Promise<SessionPayload | null> {
  try {
    const store = await cookies();
    return verifySession(store.get(COOKIE_NAME)?.value);
  } catch {
    return null;
  }
}

/**
 * API 路由的登录守卫。
 *
 * 返回值刻意设计成「未登录才返回值」：
 * 已登录返回 null，调用方写成 `const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;`
 * 即可。早先版本返回 `{ ok: true }` 这类真值对象，调用方的 `if (unauthorized)` 会在**已登录时**也成立，
 * 导致路由把守卫对象当成响应返回——这类 bug 在开发期表现为接口莫名 200 但没有数据，很难一眼看出。
 */
export async function requireAuth(): Promise<Response | null> {
  const session = await readSession();
  if (session) return null;
  return Response.json({ error: "尚未登录" }, { status: 401 });
}

/** .env 是否已经配置了可用的登录口令。 */
export function hasConfiguredPassword(): boolean {
  return Boolean(process.env.APP_PASSWORD?.trim());
}

/**
 * 本次启动的令牌。
 *
 * 桌面客户端每次启动都随机生成一个，只通过环境变量传给后端子进程，
 * **不落盘、不进 .env**。它解决的是「用户不该被要求输密码」这件事：
 * 窗口打开时用它换一个会话，用户全程看不到任何输入框。
 *
 * 令牌只对当次进程有效——就算被别的程序读到，也换不出一个能用的会话。
 */
export function bootToken(): string {
  return process.env.GAOTAI_BOOT_TOKEN?.trim() ?? "";
}

/** 校验启动令牌。 */
export function verifyBootToken(token: string): boolean {
  const expected = bootToken();
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
