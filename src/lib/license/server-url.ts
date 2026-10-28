/**
 * 内置授权服务器地址。
 *
 * 打包后的客户端没有可编辑的 .env，「去哪激活」必须是编译期就确定的常量，
 * 否则用户拿到的安装包永远显示「未配置授权服务器」。
 *
 * 优先级：环境变量 `GAOTAI_LICENSE_SERVER` > 这里的常量。
 * 留空表示尚未接入——激活页会明确提示未配置，而不是静默放行。
 *
 * 发布前把它填成正式域名（例：`https://license.example.com`），
 * 并同步更新 `docs/license-protocol.md` §1 的例子。
 */
export const BUILTIN_LICENSE_SERVER = "";

/** 解析当前生效的授权服务器地址；未配置返回 null。 */
export function resolveLicenseServer(): string | null {
  const fromEnv = process.env.GAOTAI_LICENSE_SERVER?.trim();
  const value = fromEnv || BUILTIN_LICENSE_SERVER.trim();
  if (!value) return null;
  return value.replace(/\/+$/, "");
}
