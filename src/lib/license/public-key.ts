/**
 * 内置 Ed25519 公钥。
 *
 * 私钥只在授权服务器侧（不入库、不进 git），客户端只带公钥做验签。
 * 公钥随客户端打包，是「服务端签的 token 在客户端能不能验过」的唯一锚点。
 *
 * 开发/测试可用环境变量 `GAOTAI_LICENSE_PUBKEY` 覆盖（传完整 PEM 字符串），
 * 这样测试能用自己临时生成的密钥对签 token、再让客户端验，不必依赖生产公钥。
 */

const BUILTIN_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATLqVDETmq6zXTKnOfaTxNz8uGr2fXZSb9StgmKsOlDk=
-----END PUBLIC KEY-----`;

/**
 * 当前生效的公钥 PEM。
 *
 * 优先取环境变量；取不到用内置的。环境变量必须是一段完整可被
 * `crypto.createPublicKey()` 解析的 PEM（即带 BEGIN/END 行）。
 */
export function licensePublicKey(): string {
  const override = process.env.GAOTAI_LICENSE_PUBKEY?.trim();
  return override || BUILTIN_PUBKEY;
}
