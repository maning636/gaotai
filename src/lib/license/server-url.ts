/**
 * 内置授权服务器地址。
 *
 * 打包后的客户端没有可编辑的 .env，「去哪激活」必须是编译期就确定的常量，
 * 否则用户拿到的安装包永远显示「未配置授权服务器」。
 *
 * 优先级：
 * 1. 环境变量 `GAOTAI_LICENSE_SERVER`（非空）—— 指向别处，便于自建/联调；
 * 2. 环境变量显式设为空字符串 —— 关闭内置地址，测试用；
 * 3. 生产构建（NODE_ENV=production）—— 用下面的内置地址列表；
 * 4. 其余情况（开发、测试）—— 不回落内置地址，避免本地跑测试时误连生产。
 *
 * 第 3 条为什么限定生产：`npm test` 里有一条「未配置服务器应返回
 * server_not_configured」的用例，若开发态也回落内置地址，测试会真的去连线上服务器。
 *
 * 为什么要一个列表：换域名时，已经装出去的老客户端只认编译期写死的地址。
 * 备一条可用的通路，DNS 切换期间老用户不会突然全部激活失败；主地址恢复后
 * 客户端自动用主地址，备用通路可以随时下线。
 */

/** 主地址。 */
export const BUILTIN_LICENSE_SERVER = "https://license.maning789link.top";

/**
 * 备用地址（按顺序尝试）。
 *
 * 当前这一条是过渡期的临时通路：`bid.maning789link.top` 早已解析到同一台服务器、
 * 且在现有证书覆盖范围内，但没有任何站点占用它。等主地址解析生效后可以删掉这里。
 */
export const BUILTIN_LICENSE_FALLBACKS = ["https://bid.maning789link.top"];

/** 去掉尾部斜杠，统一成不带尾斜杠的基址。 */
function normalize(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * 解析当前生效的授权服务器地址列表（按优先级排列，至少一个才算已配置）。
 *
 * 环境变量只给一条时，不再追加内置备用地址——显式指定就表示「只连这里」。
 */
export function resolveLicenseServers(): string[] {
  const raw = process.env.GAOTAI_LICENSE_SERVER;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // 显式设成空串 = 明确关闭，不再回落到内置地址（测试与离线自测用）。
    return trimmed ? [normalize(trimmed)] : [];
  }
  if (process.env.NODE_ENV !== "production") return [];

  const list = [BUILTIN_LICENSE_SERVER, ...BUILTIN_LICENSE_FALLBACKS]
    .map(item => item.trim())
    .filter(Boolean)
    .map(normalize);
  return Array.from(new Set(list));
}

/** 解析当前生效的主授权服务器地址；未配置返回 null（给 UI 与状态展示用）。 */
export function resolveLicenseServer(): string | null {
  return resolveLicenseServers()[0] ?? null;
}
