import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../paths";

/**
 * 读取 Electron 主进程落盘的桥接状态。
 *
 * WS 会话表在 Electron 主进程里，后端子进程看不到。主进程每次会话变化就把
 * `{ clients, extensions, tasks, port }` 写进数据目录，这里只负责读。
 *
 * 为什么不走后端主动查询：多一条 RPC 就多一种「桥没起来」的失败面，
 * 而这本来就是一份可容忍延迟的状态展示。文件读不到就当 0，不抛错。
 */

export type BridgeState = {
  clients: number;
  extensions: number;
  tasks: number;
  port: number;
  /** 写入时间（毫秒）。用来判断状态是不是早就过期了。 */
  updatedAt: number;
};

const EMPTY: BridgeState = { clients: 0, extensions: 0, tasks: 0, port: 0, updatedAt: 0 };

/** 状态超过这个时长就认为主进程没在报活（比如窗口关了、桥停了）。 */
const STALE_MS = 60_000;

export function readBridgeState(): BridgeState {
  const file = path.join(dataDir(), "bridge-state.json");
  if (!existsSync(file)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<BridgeState>;
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    return {
      clients: num(raw.clients),
      extensions: num(raw.extensions),
      tasks: num(raw.tasks),
      port: num(raw.port),
      updatedAt: num(raw.updatedAt),
    };
  } catch {
    return EMPTY;
  }
}

/** 状态是否还新鲜。过期说明没有扩展会话在维持心跳。 */
export function isBridgeStateFresh(state: BridgeState, now = Date.now()): boolean {
  return state.updatedAt > 0 && now - state.updatedAt <= STALE_MS;
}
