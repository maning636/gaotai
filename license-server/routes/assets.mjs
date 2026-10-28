import { ok, failByCode, bearerToken } from '../lib/http.mjs';
import { verifyToken, isTokenExpired } from '../lib/token.mjs';

// GET /v1/assets/manifest  与  GET /v1/assets/:name?version=...
// 协议 §4.4 / §4.5：需 Authorization: Bearer <token>
// 资产接口用公钥验签即可，不需要查库——token 本身就是凭证
export async function handle(ctx, req, res, url) {
  const { assets, config } = ctx;

  const tokenStr = bearerToken(req);
  if (!tokenStr) {
    failByCode(res, 'unauthorized', '缺少 Authorization 头');
    return;
  }

  const v = verifyToken(config.publicKey, tokenStr);
  if (!v.ok) {
    failByCode(res, 'unauthorized', 'token 验签失败');
    return;
  }
  // 协议 §5：token 过期即取不到新资产
  if (isTokenExpired(v.payload)) {
    failByCode(res, 'unauthorized', 'token 已过期');
    return;
  }

  // /v1/assets/manifest
  if (url.pathname === '/v1/assets/manifest' || url.pathname === '/v1/assets/manifest/') {
    const data = assets.manifestData();
    if (!data) {
      failByCode(res, 'not_found', '资产清单不存在');
      return;
    }
    ok(res, data);
    return;
  }

  // /v1/assets/:name?version=...
  const m = url.pathname.match(/^\/v1\/assets\/([^/]+)$/);
  if (!m) {
    failByCode(res, 'not_found', '资产不存在');
    return;
  }
  const name = m[1];
  const version = url.searchParams.get('version');
  if (!version) {
    failByCode(res, 'bad_request', '缺少 version 参数');
    return;
  }

  const result = assets.encryptedAsset(name, version, tokenStr);
  if (result.error) {
    failByCode(res, result.error, result.error === 'not_found' ? '资产不存在或版本不匹配' : '资产读取失败');
    return;
  }

  ok(res, result.data);
}
