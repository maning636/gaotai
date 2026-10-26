import { getAccessToken, WechatError } from "./wechat";
import { readWechatCredentials, type WechatCredentials } from "./wechat-config";

/**
 * 公众号接入检查。
 *
 * 这一层专门干一件事：**把微信的报错翻译成人话，并告诉用户下一步做什么。**
 *
 * 为什么值得单独做一层：
 *
 * 1. 微信的 access_token 接口是整条链路的门槛——凭据不对、白名单没加、
 *    账号没权限，全都在这一步挡住。而它报的是一串错误码和半截英文，
 *    用户看到「微信接口报错 40164：invalid ip 61.144.242.162 not in whitelist」
 *    根本不知道要去哪儿改。
 * 2. 40164 的报错里**带着微信看到的本机出口 IP**。把它抠出来直接告诉用户
 *    「把这个 IP 加到白名单里」，就省掉了用户自己去别处查自己的公网 IP 这一步——
 *    也不用把用户的 IP 发给任何第三方服务去查。
 * 3. 「先测后发」需要一条**能明确判定通过与否**的线。取 token 成功就是通过，
 *    失败就是没通过，没有第三种状态。
 *
 * 检查本身不发任何多余请求：access_token 有两小时有效期并被缓存，
 * 所以「测一次、接着推草稿」不会多取一次 token。
 */

export type WechatCheckResult = {
  /** 通没通过。 */
  ok: boolean;
  /** 微信业务错误码（通过时没有）。 */
  errcode?: number;
  /** 微信原始错误描述（通过时没有）。 */
  errmsg?: string;
  /** 一句话说清是什么问题。 */
  reason: string;
  /** 用户接下来该做什么。 */
  hint: string;
  /** 微信看到的本机出口 IP。40164 时从报错里抠出来。 */
  egressIp?: string;
};

/**
 * 微信错误码 → 人话。
 *
 * 只写微信真的在用的码，不编。未知码走兜底：把 errcode 和 errmsg 原样带出去，
 * 至少让人能拿去搜。
 */
const ERROR_EXPLANATIONS: Record<number, { reason: string; hint: string }> = {
  40013: {
    reason: "AppID 不对",
    hint: "检查公众号后台「设置与开发 → 基本配置」里的 AppID，填的时候别带空格。",
  },
  40125: {
    reason: "AppSecret 不对",
    hint: "AppSecret 只在公众号后台显示一次。如果重置过 Secret，要用最新的那一份。",
  },
  40001: {
    reason: "凭据无效",
    hint: "AppID 与 AppSecret 不是同一对的，或者 Secret 已经被重置过。",
  },
  40164: {
    reason: "本机出口 IP 不在公众号的 IP 白名单里",
    hint:
      "到公众号后台「设置与开发 → 基本配置 → IP白名单」，把上面这个 IP 加进去。" +
      "改完要等 5–10 分钟才生效，再回来点一次「测试连接」。",
  },
  40226: {
    reason: "本机 IP 被微信列进了黑名单",
    hint: "换一个网络环境再试（比如手机热点），或者到公众号后台检查账号状态。",
  },
  48001: {
    reason: "这个公众号没有草稿箱接口的权限",
    hint:
      "草稿箱接口只对服务号和已认证订阅号开放；未认证的订阅号、个人号用不了。" +
      "如果只是要排版稿子，可以改用「复制排版正文」贴进公众号后台。",
  },
  45009: {
    reason: "调用太频繁",
    hint: "等一会儿再试。微信对同一个账号的接口调用有频率限制。",
  },
  41002: {
    reason: "缺少 access_token",
    hint: "点一次「测试连接」重新取凭证，再推草稿。",
  },
};

/**
 * 从微信的报错描述里抠出本机出口 IP。
 *
 * 40164 的 errmsg 长这样：
 * `invalid ip 61.144.242.162, not in whitelist`
 * `invalid ip 61.144.242.162 not in whitelist`
 *
 * 抠出来是为了让用户**直接抄**，省掉「我的公网 IP 是多少」这一步——
 * 而且不用把用户的 IP 发给任何第三方查询服务。
 */
export function extractEgressIp(errmsg: string | undefined): string | undefined {
  if (!errmsg) return undefined;
  const hit = errmsg.match(/invalid\s+ip\s+([\d.]+)/i);
  if (!hit) return undefined;
  const ip = hit[1];
  // 只认看起来像 IPv4 的，别把别的东西当 IP 报出去。
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : undefined;
}

/**
 * 把微信的一个错误码翻译成人话。
 *
 * 单独导出是为了能直接测：这一层的价值全在文案准不准上，
 * 而文案是纯函数，不用发任何请求就能验。
 */
export function explainWechatError(errcode: number | undefined, errmsg: string | undefined): {
  reason: string;
  hint: string;
  egressIp?: string;
} {
  const known = errcode !== undefined ? ERROR_EXPLANATIONS[errcode] : undefined;
  const egressIp = extractEgressIp(errmsg);
  if (known) {
    return { reason: known.reason, hint: known.hint, ...(egressIp ? { egressIp } : {}) };
  }
  // 未知错误码：把微信原话带上，至少能拿去搜。
  const raw = errmsg?.trim();
  return {
    reason: raw ? `微信返回了 ${errcode ?? "未知错误"}：${raw}` : `微信返回了 ${errcode ?? "未知错误"}`,
    hint: "这是稿台没认识的一种错误。把上面的原文拿去搜一下微信文档，或到公众号后台确认账号状态。",
    ...(egressIp ? { egressIp } : {}),
  };
}

/**
 * 检查公众号能不能用。
 *
 * 通过 = 能拿到 access_token。这一步同时验了三件事：
 * 凭据对不对、本机 IP 在不在白名单、这个账号有没有这个接口的权限。
 *
 * 不传 creds 就用 .env 里存的那一份。
 */
export async function checkWechatConnection(creds?: WechatCredentials): Promise<WechatCheckResult> {
  const resolved = creds ?? readWechatCredentials();
  // 凭据没填是「还没配」，不是「连不上」——先把这一种分出来，
  // 免得用户以为网络坏了。
  if (!resolved.appId || !resolved.appSecret) {
    return {
      ok: false,
      reason: "还没有配公众号凭据",
      hint: "把 AppID 和 AppSecret 填进「公众号」页面，再点一次「测试连接」。",
    };
  }
  try {
    await getAccessToken(resolved);
    return {
      ok: true,
      reason: "公众号通道已打通",
      hint: "现在可以推到草稿箱了。",
    };
  } catch (error) {
    if (error instanceof WechatError) {
      // 有业务错误码 = 微信答复了，只是答复的是「不行」，翻译成人话。
      if (error.errcode !== undefined) {
        const explained = explainWechatError(error.errcode, error.errmsg);
        return {
          ok: false,
          errcode: error.errcode,
          ...(error.errmsg ? { errmsg: error.errmsg } : {}),
          ...explained,
        };
      }
      // 没有错误码 = 请求本身没走通（超时、断网、HTTP 5xx）。
      // 这跟「微信说你不行」是两回事，别混成「未知错误」。
      const message = error.message;
      if (message.includes("超时")) {
        return {
          ok: false,
          reason: "微信接口请求超时",
          hint: "网络太慢或被挡住了。检查网络，或者过一会儿再试一次。",
        };
      }
      return {
        ok: false,
        reason: "连不上微信服务器",
        hint: `${message}。检查一下网络能不能访问 api.weixin.qq.com。`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "连不上微信服务器",
      hint: `${message}。检查一下网络能不能访问 api.weixin.qq.com。`,
    };
  }
}
