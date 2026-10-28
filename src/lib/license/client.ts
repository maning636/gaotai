import { readFileSync } from "node:fs";
import path from "node:path";
import type { ActivationData, ClientResult, ErrorCode, StatusData } from "./types";
import { resolveLicenseServers } from "./server-url";

/**
 * 与授权服务器通信（协议 §1 / §4）。
 *
 * - `requestJson(url, body, timeoutMs)`：用 `AbortSignal.timeout`，fetch 失败/超时/非 JSON 统一映射成 `{ ok:false, error:{ code:'server_unreachable' | 'bad_response', message } }`，中文文案要具体。
 * - `activate` / `refresh` / `status`：读 `GAOTAI_LICENSE_SERVER`，**未配置时直接返回 `server_not_configured`**，绝不静默成功。
 * - 上报 `User-Agent: gaotai/<version>` 与 `X-Gaotai-App`。版本从 `package.json` 读，不写死。
 * - 成功后**不**自己写缓存（由 gate 决定写入），只返回 data。
 *
 * 三个接口对应协议 §4.1 / §4.2 / §4.3，路由前缀统一 `/v1`。
 */

/** activate 请求体（协议 §4.1）。 */
type ActivateRequestBody = {
  code: string;
  machine: string;
  appVersion: string;
  os: string;
};

/** refresh 请求体（协议 §4.2）。 */
type RefreshRequestBody = {
  code: string;
  machine: string;
  appVersion: string;
};

/** status 请求体（协议 §4.3）。 */
type StatusRequestBody = {
  code: string;
  machine: string;
};

/**
 * 从 `package.json` 读版本号。
 *
 * 用动态 require + try/catch：桌面客户端运行时 `package.json` 可能不在同目录，
 * 取不到就用 `"0.0.0"` 兜底，不能因为读不到版本就让激活失败。
 */
function appVersion(): string {
  // 用 fs 读而不是 require：Turbopack 会把 `require(动态路径)` 当成模块依赖去解析，
  // 构建期报「Module not found: /ROOT/package.json」，运行期只剩 0.0.0 兜底。
  // 打包态 standalone 目录下不一定有 package.json，读不到就用 0.0.0，不影响激活。
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 取授权服务器地址。
 *
 * 读 `GAOTAI_LICENSE_SERVER`，去尾斜杠。未配置返回 null。
 * 生产必须 HTTPS；开发可用 `http://127.0.0.1:8787`——这里不做 scheme 校验，
 * 协议说「生产必须 HTTPS」是部署约束，不是客户端运行时校验。
 */
/**
 * 按优先级逐个尝试授权服务器，返回第一个「通了」的响应。
 *
 * 只有 `server_unreachable`（DNS 失败/连不上/超时）才换下一个：
 * 服务器明确回了业务错误，说明这条通路是通的，再换地址只会拿到同样的答案，
 * 还会把「码被别人用了」误报成「连不上服务器」。
 */
async function postV1(
  path: string,
  body: Record<string, unknown>,
): Promise<ClientResult<Record<string, unknown>>> {
  const servers = resolveLicenseServers();
  if (!servers.length) {
    return {
      ok: false,
      error: {
        code: "server_not_configured",
        message: "未配置授权服务器地址，请在设置中填写 GAOTAI_LICENSE_SERVER。",
      },
    };
  }
  let last: ClientResult<Record<string, unknown>> | null = null;
  for (const base of servers) {
    const result = await requestJson(`${base}${path}`, body);
    if (result.ok || result.error.code !== "server_unreachable") return result;
    last = result;
  }
  return last ?? {
    ok: false,
    error: { code: "server_unreachable", message: "连不上授权服务器，请检查网络或稍后再试。" },
  };
}

/**
 * 发一个 POST 请求，解析 JSON 信封。
 *
 * - 用 `AbortSignal.timeout(timeoutMs)`，默认 8 秒。
 * - fetch 失败/超时/网络错 → `server_unreachable`（中文：「连不上授权服务器，请检查网络或稍后再试」）。
 * - 非 JSON / JSON 解析失败 → `bad_response`（中文：「授权服务器返回了无法解析的内容」）。
 * - HTTP 非 2xx 但 body 是合法信封：按信封里的 error 透传（服务端自己定义 code/message）。
 * - HTTP 2xx 且信封 `ok:true`：返回 data。
 *
 * 这个函数不关心具体接口路径，只做「请求 + 解析信封」。
 */
export async function requestJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<ClientResult<Record<string, unknown>>> {
  const version = appVersion();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": `gaotai/${version}`,
        "X-Gaotai-App": version,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "server_unreachable",
        message: "连不上授权服务器，请检查网络或稍后再试。",
      },
    };
  }

  // 读响应体
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return {
      ok: false,
      error: {
        code: "bad_response",
        message: "授权服务器返回的内容无法读取。",
      },
    };
  }

  if (!text) {
    return {
      ok: false,
      error: {
        code: "bad_response",
        message: "授权服务器返回了空响应。",
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        code: "bad_response",
        message: "授权服务器返回了无法解析的内容。",
      },
    };
  }

  // 信封结构校验：{ ok: true, data } | { ok: false, error: { code, message } }
  const env = parsed as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
  if (env.ok === true) {
    if (env.data && typeof env.data === "object") {
      return { ok: true, data: env.data as Record<string, unknown> };
    }
    return {
      ok: false,
      error: {
        code: "bad_response",
        message: "授权服务器返回的信封缺少 data 字段。",
      },
    };
  }
  if (env.ok === false) {
    const code = typeof env.error?.code === "string" ? (env.error.code as ErrorCode) : "bad_response";
    const message = typeof env.error?.message === "string" ? env.error.message : "授权服务器返回了未知的错误。";
    return { ok: false, error: { code, message } };
  }

  return {
    ok: false,
    error: {
      code: "bad_response",
      message: "授权服务器返回的信封格式不符合协议。",
    },
  };
}

/**
 * 激活（协议 §4.1 POST /v1/activate）。
 *
 * 请求：`{ code, machine, appVersion, os }`
 * 成功 data：`{ token, expiresAt, features, plan, code }`
 * 失败：`invalid_code` / `code_revoked` / `device_limit` / `rate_limited` / `bad_request`
 *
 * 未配置服务器 → `server_not_configured`（不静默成功）。
 */
export async function activate(req: {
  code: string;
  machine: string;
}): Promise<ClientResult<ActivationData>> {
  const body: ActivateRequestBody = {
    code: req.code,
    machine: req.machine,
    appVersion: appVersion(),
    os: `${process.platform} ${process.version}`.trim(),
  };
  const result = await postV1("/v1/activate", body);
  if (!result.ok) return result;
  const data = result.data as Partial<ActivationData>;
  if (
    typeof data.token !== "string" ||
    typeof data.expiresAt !== "number" ||
    !Array.isArray(data.features) ||
    typeof data.plan !== "string" ||
    typeof data.code !== "string"
  ) {
    return {
      ok: false,
      error: {
        code: "bad_response",
        message: "授权服务器返回的激活数据不完整。",
      },
    };
  }
  return { ok: true, data: data as ActivationData };
}

/**
 * 刷新（协议 §4.2 POST /v1/refresh）。
 *
 * 请求：`{ code, machine, appVersion }`
 * 未绑定该 machine → `machine_mismatch`；code 被吊销 → `code_revoked`。
 */
export async function refresh(req: {
  code: string;
  machine: string;
}): Promise<ClientResult<ActivationData>> {
  const body: RefreshRequestBody = {
    code: req.code,
    machine: req.machine,
    appVersion: appVersion(),
  };
  const result = await postV1("/v1/refresh", body);
  if (!result.ok) return result;
  const data = result.data as Partial<ActivationData>;
  if (
    typeof data.token !== "string" ||
    typeof data.expiresAt !== "number" ||
    !Array.isArray(data.features) ||
    typeof data.plan !== "string" ||
    typeof data.code !== "string"
  ) {
    return {
      ok: false,
      error: {
        code: "bad_response",
        message: "授权服务器返回的刷新数据不完整。",
      },
    };
  }
  return { ok: true, data: data as ActivationData };
}

/**
 * 查询状态（协议 §4.3 POST /v1/status）。
 *
 * 请求：`{ code, machine }`
 * 成功 data：`{ activated, revoked, expiresAt, lastSeenAt, plan }`
 */
export async function status(req: {
  code: string;
  machine: string;
}): Promise<ClientResult<StatusData>> {
  const body: StatusRequestBody = {
    code: req.code,
    machine: req.machine,
  };
  const result = await postV1("/v1/status", body);
  if (!result.ok) return result;
  const data = result.data as Partial<StatusData>;
  if (
    typeof data.activated !== "boolean" ||
    typeof data.revoked !== "boolean" ||
    typeof data.plan !== "string"
  ) {
    return {
      ok: false,
      error: {
        code: "bad_response",
        message: "授权服务器返回的状态数据不完整。",
      },
    };
  }
  return {
    ok: true,
    data: {
      activated: data.activated,
      revoked: data.revoked,
      expiresAt: data.expiresAt ?? null,
      lastSeenAt: data.lastSeenAt ?? null,
      plan: data.plan,
    },
  };
}
