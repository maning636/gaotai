/**
 * Node 自带 fetch 的响应头超时。
 *
 * Node 的 fetch 走内置的 undici，默认只等 300 秒的响应头。这在写长文时会要命：
 * 模型要先安静地想完、再把正文一次生成完，非流式请求的响应头要等正文全部生成完
 * 才发出来——模型花 5 分钟写稿，我们这边 5 分钟整就把连接掐了，
 * 用户等了半天只换来一句「模型请求失败」。
 *
 * 上游 we-article 踩的就是这个坑：它给 SDK 设了 600 秒超时，
 * 但 undici 的 300 秒头部超时先到，于是报
 * 「fetch timed out waiting for response headers; configure a matching undici fetch
 * and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout」。
 *
 * 这里把全局 dispatcher 的头部/正文超时抬到我们自己的请求超时（600 秒）之上，
 * 真正管事的一直是我们自己的 AbortSignal，不会因此变成没有上限。
 *
 * 用全局 dispatcher 而不是给 fetch 传 dispatcher 参数：后者要引入 undici 这个依赖，
 * 而 Node 已经把它内置了；直接换掉全局那一个最省事，也不给安装包多加一份依赖。
 */

/** undici 全局 dispatcher 的存放位置（undici 的 setGlobalDispatcher 就是写这个槽位）。 */
const DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");

/**
 * 头部/正文超时。必须大于我们自己的单次请求上限（稿台正文阶段 600 秒），
 * 否则我们自己都还没放弃，连接先断了。
 */
const HEADERS_TIMEOUT_MS = 900_000;
const BODY_TIMEOUT_MS = 900_000;
const CONNECT_TIMEOUT_MS = 30_000;

type DispatcherLike = {
  constructor?: new (options: Record<string, number>) => unknown;
};

type GlobalWithDispatcher = typeof globalThis & { [key: symbol]: unknown };

/**
 * 抬高全局 fetch 的响应头等待上限。
 *
 * 返回是否成功替换——换不了也不影响使用（请求还是按 Node 的默认值走），
 * 只是长文在极慢的模型上有被提前掐断的风险。
 */
export function ensureLongLivedFetchTimeout(): boolean {
  try {
    const scope = globalThis as GlobalWithDispatcher;
    const current = scope[DISPATCHER_SYMBOL] as DispatcherLike | undefined;
    if (!current?.constructor) return false;
    const agent = new current.constructor({
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: BODY_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });
    scope[DISPATCHER_SYMBOL] = agent;
    return true;
  } catch {
    return false;
  }
}

/** 当前全局 dispatcher 的头部超时（毫秒）。取不到就返回 undefined。 */
export function currentHeadersTimeout(): number | undefined {
  try {
    const scope = globalThis as GlobalWithDispatcher;
    const current = scope[DISPATCHER_SYMBOL] as
      | { options?: { headersTimeout?: number } }
      | undefined;
    const value = current?.options?.headersTimeout;
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}
