/**
 * 内置授权服务器地址。
 *
 * 打包后的客户端没有可编辑的 .env，「去哪激活」必须是编译期就确定的常量，
 * 否则用户拿到的安装包永远显示「未配置授权服务器」。
 *
 * 优先级：
 * 1. 环境变量 `GAOTAI_LICENSE_SERVER`（非空）—— 指向别处，便于自建/联调；
 * 2. 环境变量显式设为空字符串 —— 关闭内置地址，测试用；
 * 3. 生产构建（NODE_ENV=production）—— 用下面的内置地址；
 * 4. 其余情况（开发、测试）—— 不回落内置地址，避免本地跑测试时误连生产。
 *
 * 第 3 条为什么限定生产：`npm test` 里有一条「未配置服务器应返回
 * server_not_configured」的用例，若开发态也回落内置地址，测试会真的去连线上服务器。
 */
export const BUILTIN_LICENSE_SERVER = "https://license.maning789link.top";

/** 去掉尾部斜杠，统一成不带尾斜杠的基址。 */
function normalize(value: string): string {
  return value.replace(/\/+$/, "");
}

/** 解析当前生效的授权服务器地址；未配置返回 null。 */
export function resolveLicenseServer(): string | null {
  const raw = process.env.GAOTAI_LICENSE_SERVER;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // 显式设成空串 = 明确关闭，不再回落到内置地址（测试与离线自测用）。
    return trimmed ? normalize(trimmed) : null;
  }
  if (process.env.NODE_ENV !== "production") return null;
  const builtin = BUILTIN_LICENSE_SERVER.trim();
  return builtin ? normalize(builtin) : null;
}
