// 微信公众号回调路由：GET /wechat（验签回 echostr）与 POST /wechat（收消息回被动回复）。
//
// 约束：
//  - 5 秒内必须返回：微信对回调有时限。稿台码路径全部是内存/本地 JSON，天然满足。
//    标书码路径（issueBackend='bidmaster-api'）会向同机标书服务发一次 HTTP
//    （127.0.0.1:8093，登录+建码 <300ms），仍在时限内；失败降级为提示不发码。
//  - 重复推送幂等：微信会重试同一消息。用进程内 Map 记最近 200 个消息指纹，
//    重复的直接返回空串，不重复回话/发码。（稿台码经 contact 幂等；标书码经
//    bidmaster-issued.json 映射幂等。）
import { checkSignature, parseXml, textReplyXml } from '../lib/wechat.mjs';
import { handleWechatMessage } from '../lib/wechat-router.mjs';
import { generateCode } from '../lib/store.mjs';
import { createBidmasterIssuer } from '../lib/bidmaster-issuer.mjs';
import { createHash } from 'node:crypto';

// 去重窗口：记住最近 200 个已处理的消息指纹。
// 指纹优先用 MsgId（微信对同一条消息重试时不变）；没有 MsgId 时退化为
// FromUserName+CreateTime+Content 的哈希（事件消息常不带 MsgId）。
const DEDUP_MAX = 200;

// 消息指纹：MsgId 优先；否则用 sha1(openid+createTime+content/event) 稳定哈希。
export function messageFingerprint(msg) {
  if (msg && msg.MsgId) return 'id:' + msg.MsgId;
  const parts = [msg?.FromUserName || '', msg?.CreateTime || '', msg?.MsgType || ''];
  if (msg?.Content) parts.push(msg.Content);
  if (msg?.Event) parts.push(msg.Event);
  if (msg?.EventKey) parts.push(msg.EventKey);
  // createHash 是同步纯计算，这里用它做稳定字符串化，不涉及密钥
  return 'h:' + createHash('sha1').update(parts.join('|')).digest('hex');
}

// 创建去重器：进程内 Map，LRU 淘汰最旧。
export function createDeduper(max = DEDUP_MAX) {
  const seen = new Map(); // fingerprint -> true
  return {
    // 返回 true 表示「之前处理过」，调用方应直接返回空串
    seen(fingerprint) {
      if (seen.has(fingerprint)) return true;
      seen.set(fingerprint, true);
      // 超出窗口淘汰最旧（Map 迭代序即插入序）
      while (seen.size > max) {
        const first = seen.keys().next().value;
        seen.delete(first);
      }
      return false;
    },
    _map: seen,
  };
}

// 读原始 XML body（上限沿用 64KB，微信消息远小于此）
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export function createWechatRoute({ config, store, randomInt }) {
  // 去重器按实例创建，测试可注入独立实例避免跨用例污染
  const deduper = createDeduper();

  // 发码回调：同一 openid 重复发码由 store 的 contact 幂等返回原码。
  // 返回码字符串；失败返回 null（由路由层降级提示，不让回调 500）。
  async function issueCodeForOpenid(openid, product) {
    if (!openid) return null;
    const code = generateCode(store, randomInt, config.codeFormat);
    const record = await store.issueCode({
      code,
      contact: openid,
      channel: 'wechat-oa',
      note: (product && product.name) || 'wechat',
    });
    return record.code;
  }

  // 标书产品发码桥：调标书服务器管理 API 在其 licenses 表落 15 天试用码。
  // 同机部署（127.0.0.1:8093），耗时 <300ms，满足微信 5 秒回调时限。
  // 未配置 BIDMASTER_ADMIN_USER/PASS 时 configured()=false，发码会抛错 →
  // 路由层降级为兜底提示（不让回调 500），稿台码不受影响。
  const bidmasterIssuer = createBidmasterIssuer({ dataDir: config.dataDir, env: process.env });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const token = config.wechatToken || '';
    const timestamp = url.searchParams.get('timestamp') || '';
    const nonce = url.searchParams.get('nonce') || '';
    const signature = url.searchParams.get('signature') || '';

    // 未配置 WECHAT_TOKEN：一律 403，不暴露服务细节
    if (!token) {
      console.warn('未配置 WECHAT_TOKEN，/wechat 一律 403');
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }

    // 验签失败 403。用 timingSafeEqual 的 checkSignature。
    if (!checkSignature({ token, signature, timestamp, nonce })) {
      store.appendAudit({ ip: '', codePrefix: '', errorCode: 'wechat_error', event: 'wechat' });
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }

    // GET：微信接入校验，回显 echostr（text/plain）
    if (req.method === 'GET') {
      const echostr = url.searchParams.get('echostr') || '';
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(echostr);
      return;
    }

    // POST：收消息
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) {
        store.appendAudit({ ip: '', codePrefix: '', errorCode: 'wechat_error', event: 'wechat' });
        res.statusCode = 200;
        res.end('');
        return;
      }
      const msg = parseXml(body);
      if (!msg.MsgType) {
        // 解析不出消息类型：视为无效，回空串避免微信重试风暴
        store.appendAudit({ ip: '', codePrefix: '', errorCode: 'wechat_error', event: 'wechat' });
        res.statusCode = 200;
        res.end('');
        return;
      }

      // 重复推送幂等：处理过就不再回话（不发码、不回欢迎语）
      const fp = messageFingerprint(msg);
      if (deduper.seen(fp)) {
        res.statusCode = 200;
        res.end('');
        return;
      }

      const openid = msg.FromUserName || '';
      const result = await handleWechatMessage({
        message: msg,
        config: config.wechat,
        openid,
        // 产品级发码后端分发：默认本地 store（稿台码）；
        // issueBackend === 'bidmaster-api' 走标书服务器管理 API（15 天试用码，
        // 落在标书自己的 licenses 表，客户端激活才认）。见 lib/bidmaster-issuer.mjs。
        issue: (oid, product) =>
          product && product.issueBackend === 'bidmaster-api'
            ? bidmasterIssuer.issueForOpenid(oid, product)
            : issueCodeForOpenid(oid, product),
      });

      if (!result.reply) {
        // 不回话（如取关事件）：200 空 body
        res.statusCode = 200;
        res.end('');
        return;
      }

      const xml = textReplyXml({
        toUser: openid,               // ToUserName = 用户 openid
        fromUser: config.wechatOriginalId || '',  // FromUserName = 公众号原始 ID
        content: result.reply,
        now: Date.now(),
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.end(xml);
      return;
    }

    // 其它 method：405
    res.statusCode = 405;
    res.end('method not allowed');
  }

  return { handle, deduper };
}
