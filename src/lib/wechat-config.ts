import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { envFile } from "./paths";

/**
 * 公众号凭据的存取。
 *
 * 凭据只存在 .env 里，和其它敏感配置放在一起，不进数据库、不进日志。
 * 写入时是**改写**而不是追加——同一个键名在 .env 里出现两行时，
 * 后面的会覆盖前面的，用户改完发现"没生效"通常就是这么来的。
 */

export type WechatCredentials = {
  appId: string;
  appSecret: string;
};

const APP_ID_KEYS = ["WECHAT_APPID", "WECHAT_APP_ID"];
const APP_SECRET_KEYS = ["WECHAT_APPSECRET", "WECHAT_APP_SECRET"];

/** 从 .env 文本里取一个键的值。 */
function readKey(text: string, keys: string[]): string {
  for (const key of keys) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`, "m");
    const hit = text.match(pattern);
    if (!hit) continue;
    const value = hit[1].trim();
    if (!value) continue;
    return value.replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
  return "";
}

function readEnvFile(): string {
  try {
    return readFileSync(envFile(), "utf8");
  } catch {
    return "";
  }
}

/** 读取公众号凭据。没配就是空串。 */
export function readWechatCredentials(): WechatCredentials {
  const text = readEnvFile();
  return {
    appId: readKey(text, APP_ID_KEYS),
    appSecret: readKey(text, APP_SECRET_KEYS),
  };
}

/** 是否已经配置齐全。 */
export function hasWechatCredentials(): boolean {
  const { appId, appSecret } = readWechatCredentials();
  return Boolean(appId && appSecret);
}

/**
 * 改写 .env 里的若干行。
 *
 * 逐行处理：命中键名就替换成新值（保留原有注释行不受影响），
 * 没有就在文件末尾追加。注释、空行、其它键的顺序全部保持原样。
 */
async function writeEnvValues(values: Record<string, string>): Promise<void> {
  const target = envFile();
  const dir = path.dirname(target);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  const original = readEnvFile();
  const written = new Set<string>();
  const lines = original.split(/\r?\n/).map(line => {
    const hit = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    const key = hit?.[1];
    if (!key || !(key in values) || written.has(key)) return line;
    written.add(key);
    return `${key}=${values[key]}`;
  });

  const missing = Object.keys(values).filter(key => !written.has(key));
  let output = lines.join("\n");
  if (missing.length) {
    const addition = missing.map(key => `${key}=${values[key]}`).join("\n");
    output = `${output.replace(/\s*$/, "")}\n${addition}\n`;
  } else if (!output.endsWith("\n")) {
    output += "\n";
  }

  await writeFile(target, output, { encoding: "utf8", mode: 0o600 });

  // 同步到当前进程，后续立刻调用微信接口不用重启。
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

/** 保存公众号凭据。 */
export async function saveWechatCredentials(creds: WechatCredentials): Promise<void> {
  await writeEnvValues({
    WECHAT_APPID: creds.appId.trim(),
    WECHAT_APPSECRET: creds.appSecret.trim(),
  });
}

/** 掩码：只留前 4 位和后 4 位，中间用点盖住。 */
export function maskAppId(appId: string): string {
  const value = appId.trim();
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/* ------------------------------------------------------------------ *
 * 封面图
 *
 * 公众号草稿必须带一张封面（thumb_media_id），这个值是**永久素材**的 media_id，
 * 不是随便一个图片地址。它必须单独上传一次才能拿到，所以和凭据一样存进 .env。
 * ------------------------------------------------------------------ */

const THUMB_MEDIA_ID_KEYS = ["WECHAT_THUMB_MEDIA_ID"];
const THUMB_IMAGE_KEYS = ["WECHAT_THUMB_IMAGE"];

export type WechatCover = {
  /** 微信永久素材的 media_id，作为草稿封面用。 */
  mediaId: string;
  /** 本地素材库里的相对路径，用来在界面上回显封面长什么样。 */
  image: string;
};

/** 读取封面配置。没配过就是空串。 */
export function readWechatCover(): WechatCover {
  const text = readEnvFile();
  return {
    mediaId: readKey(text, THUMB_MEDIA_ID_KEYS),
    image: readKey(text, THUMB_IMAGE_KEYS),
  };
}

/** 保存封面配置。mediaId 为空串表示清空。 */
export async function saveWechatCover(cover: WechatCover): Promise<void> {
  await writeEnvValues({
    WECHAT_THUMB_MEDIA_ID: cover.mediaId.trim(),
    WECHAT_THUMB_IMAGE: cover.image.trim(),
  });
}
