import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { agentConfigFile, envFile } from "./paths";

export type AgentConfig = {
  model: string;
  apiBaseUrl: string;
  /** 内存/接口层可见的明文 key；序列化到磁盘前会 AES-256-GCM 加密。 */
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  /**
   * 模型的思考强度。
   *
   * 带思考的端点把 max_tokens 当「思考 + 正文」的总额度：思考吃光了，
   * 正文就一个字都没有（真模型实测：SenseNova 6.8 把 16384 个 token
   * 全花在思考上，正文一个字没交出来）。
   * 写长文时把它压到 minimal，额度基本留给正文。
   *
   * 留空 = 不传这个字段，跟随端点自己的默认行为。
   */
  reasoningEffort?: ReasoningEffort;
  updatedAt?: string;
};

/**
 * 思考强度。取值与 OpenAI 兼容端点的 reasoning_effort 一致。
 *
 * minimal 是为写长文准备的：它保留最低限度的思考，又不会把额度吃光。
 * 不认这个取值的端点会回 400，模型层会自动去掉这个字段再发一次。
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type AgentConfigInput = {
  model?: string;
  apiBaseUrl?: string;
  /** 空字符串 = 沿用当前磁盘中的 key，避免「只改模型」时被迫再次输入密钥。 */
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort | "";
};

export type AgentConfigPublic = Omit<AgentConfig, "apiKey"> & { apiKeyMasked: string };

export type AgentConfigTestResult = { ok: boolean; message: string };

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";
const MASKED_KEY = "••••••••";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

type StoredConfig = {
  model: string;
  apiBaseUrl: string;
  apiKeyEncrypted?: string;
  systemPrompt: string;
  temperature: number;
  reasoningEffort?: string;
  updatedAt?: string;
};

function configPath(): string {
  return agentConfigFile();
}

async function resolveSecret(): Promise<string> {
  try {
    const raw = await readFile(envFile(), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?SESSION_SECRET\s*=\s*(.+?)\s*$/);
      if (match) return (match[1] ?? "").replace(/^(['"]|['"]).*(['"])$/, "$1").replace(/^"/, "").replace(/"$/, "").trim();
    }
    return "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function deriveKey(secret: string): Buffer {
  // secret 为空时退到设备级随机盐，而不是固定占位串：固定占位符会让
  // 任何拿到密文的人都能推导出加密口令。盐只在本次进程内有效，
  // 因此未配置 SESSION_SECRET 时保存的密文在下次启动后无法解开——
  // 这是刻意的：宁可让用户重新填写，也不要用可预测的密钥保护 API Key。
  return createHash("sha256")
    .update(`gaotai-agent-config:${secret || processSalt()}`)
    .digest();
}

// 进程级随机盐；无 SESSION_SECRET 时用于派生临时加密口令。
let salt: string | null = null;
function processSalt() {
  if (!salt) salt = randomBytes(32).toString("hex");
  return salt;
}

function encrypt(apiKey: string, key: Buffer): string {
  if (!apiKey) return "";
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const payload = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64");
}

function decrypt(payload: string, key: Buffer): string {
  if (!payload) return "";
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_LENGTH + TAG_LENGTH) throw new Error("API Key 密文长度异常。");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function defaultConfig(): AgentConfig {
  return { model: DEFAULT_MODEL, apiBaseUrl: DEFAULT_BASE_URL, apiKey: "", systemPrompt: "", temperature: 0.7 };
}

function fromStored(stored: StoredConfig, apiKey: string): AgentConfig {
  const effort = REASONING_EFFORTS.includes(stored.reasoningEffort as ReasoningEffort)
    ? (stored.reasoningEffort as ReasoningEffort)
    : undefined;
  return {
    model: stored.model ?? DEFAULT_MODEL,
    apiBaseUrl: stored.apiBaseUrl ?? DEFAULT_BASE_URL,
    apiKey,
    systemPrompt: stored.systemPrompt ?? "",
    temperature: typeof stored.temperature === "number" ? stored.temperature : 0.7,
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

function normalize(input: AgentConfigInput, fallback: AgentConfig): AgentConfig {
  const model = (input.model ?? fallback.model).trim();
  const apiBaseUrl = (input.apiBaseUrl ?? fallback.apiBaseUrl).trim();
  const systemPrompt = input.systemPrompt ?? fallback.systemPrompt;
  const temperature = input.temperature ?? fallback.temperature;
  if (!model) throw new Error("模型名不能为空。");
  if (!apiBaseUrl) throw new Error("API Base URL 不能为空。");
  if (!/^https?:\/\//i.test(apiBaseUrl))
    throw new Error("API Base URL 必须以 http:// 或 https:// 开头。");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    throw new Error("temperature 需要在 0-2 之间。");
  // 空字符串 = 「不设这个参数」，跟旧配置和默认行为一致。
  const rawEffort = input.reasoningEffort === undefined ? fallback.reasoningEffort : input.reasoningEffort;
  if (rawEffort && !REASONING_EFFORTS.includes(rawEffort)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORTS.join(" / ")}。`);
  }
  const reasoningEffort = rawEffort || undefined;
  // 空字符串表示「沿用当前 key」；未提供也表示沿用。
  const apiKey = input.apiKey === undefined || input.apiKey === "" ? fallback.apiKey : input.apiKey;
  return {
    model,
    apiBaseUrl,
    apiKey,
    systemPrompt,
    temperature,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function toPublic(config: AgentConfig): AgentConfigPublic {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKeyMasked: apiKey ? MASKED_KEY : "" };
}

export async function readAgentConfig(): Promise<AgentConfig> {
  return (await loadStored()).config;
}

// 同时返回磁盘上的原始记录与密钥是否可解，供写入时决定是否保留原密文。
async function loadStored(): Promise<{ config: AgentConfig; stored: StoredConfig | null; decryptable: boolean }> {
  const secret = await resolveSecret();
  const key = deriveKey(secret);
  let parsed: StoredConfig;
  try {
    const raw = await readFile(configPath(), "utf8");
    parsed = JSON.parse(raw) as StoredConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultConfig(), stored: null, decryptable: true };
    throw error;
  }
  try {
    return { config: fromStored(parsed, decrypt(parsed.apiKeyEncrypted ?? "", key)), stored: parsed, decryptable: true };
  } catch {
    // 密钥轮换或文件被手动改坏：保留密文供后续修复，但避免把解析异常泄漏到页面。
    return { config: fromStored(parsed, ""), stored: parsed, decryptable: false };
  }
}

export async function writeAgentConfig(input: AgentConfigInput): Promise<AgentConfig> {
  const { config: current, stored, decryptable } = await loadStored();
  const next = normalize(input, current);
  const secret = await resolveSecret();
  // 原密文解不开时（密钥曾用空 secret 加密、之后 SESSION_SECRET 才到位），
  // 绝不能用空密钥覆盖——那会让用户已填好的 API Key 永久丢失。
  const keepsUndecryptable = !decryptable && !next.apiKey && Boolean(stored?.apiKeyEncrypted);
  const payload: StoredConfig = {
    model: next.model,
    apiBaseUrl: next.apiBaseUrl,
    apiKeyEncrypted: keepsUndecryptable ? stored!.apiKeyEncrypted! : encrypt(next.apiKey, deriveKey(secret)),
    systemPrompt: next.systemPrompt,
    temperature: next.temperature,
    ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(payload, null, 2), "utf8");
  return next;
}

// 测试连接直接调 OpenAI 兼容的 /chat/completions；不经过 LangChain 是为了
// 拿到真实的 HTTP 状态与响应体，而不是被 SDK 包装成含糊的错误。
export async function testAgentConnection(config: AgentConfig, overrides?: AgentConfigInput): Promise<AgentConfigTestResult> {
  const merged = normalize(overrides ?? {}, config);
  if (!merged.apiKey) return { ok: false, message: "请先填写 API Key 再测试连接。" };
  const url = `${merged.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${merged.apiKey}`,
      },
      body: JSON.stringify({
        model: merged.model,
        messages: [
          ...(merged.systemPrompt.trim()
            ? [{ role: "system", content: merged.systemPrompt.trim() }]
            : []),
          { role: "user", content: "ping" },
        ],
        temperature: merged.temperature,
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.slice(0, 500).replace(/\s+/g, " ").trim();
      return { ok: false, message: `HTTP ${response.status}：${detail || "模型请求失败"}` };
    }
    try {
      const body = JSON.parse(text) as { error?: { message?: string }; choices?: unknown[] };
      if (body.error?.message) return { ok: false, message: `模型返回错误：${body.error.message}` };
      if (Array.isArray(body.choices) && body.choices.length === 0)
        return { ok: false, message: "模型返回空 choices，请检查模型名或参数。" };
    } catch {
      return { ok: false, message: "响应不是有效的 JSON。" };
    }
    return { ok: true, message: `连接成功：${merged.apiBaseUrl} · ${merged.model}` };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return { ok: false, message: "连接超时（120s），请检查 API Base URL 或网络。" };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `连接失败：${message}` };
  } finally {
    clearTimeout(timer);
  }
}

// 内部工具导出，便于单元测试独立验证加解密路径，不依赖磁盘。
export function _encryptApiKey(apiKey: string, secret: string): string {
  return encrypt(apiKey, deriveKey(secret));
}

export function _decryptApiKey(payload: string, secret: string): string {
  return decrypt(payload, deriveKey(secret));
}
