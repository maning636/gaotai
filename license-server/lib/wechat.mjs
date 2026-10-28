// 微信公众号回调的纯函数工具：签名校验、XML 解析、被动回复 XML 生成。
//
// 为什么独立成纯函数模块：微信回调的签名与 XML 格式是稳定契约，值得单独单测；
// 且这里不碰 IO / 网络，测试可以零成本调用，不依赖 HTTP 服务。
import { createHash, timingSafeEqual } from 'node:crypto';

// 微信签名：sha1([token, timestamp, nonce].sort().join(''))
// 返回十六进制摘要，供测试与自测脚本使用。
export function signatureOf({ token, timestamp, nonce }) {
  const raw = [token, timestamp, nonce].sort().join('');
  return createHash('sha1').update(raw, 'utf8').digest('hex');
}

// 验签：与微信传来的 signature 比对，用 timingSafeEqual 防时序侧信道。
// 任何参数缺失/类型不对都返回 false（拒绝），不抛异常——调用方据此回 403。
export function checkSignature({ token, signature, timestamp, nonce }) {
  if (!token || typeof signature !== 'string' || typeof timestamp !== 'string' || typeof nonce !== 'string') {
    return false;
  }
  const digest = createHash('sha1').update([token, timestamp, nonce].sort().join(''), 'utf8').digest();
  // Buffer.from(hex, 'hex') 对非法 hex 会静默截断，不会抛错，
  // 因此用长度比对兜住「非 hex / 长度不符」的签名，再交给 timingSafeEqual。
  const sigBuf = Buffer.from(signature, 'hex');
  if (digest.length !== sigBuf.length) return false;
  return timingSafeEqual(digest, sigBuf);
}

// 普通文本字段的实体解码：&lt; &gt; &amp; &quot; &apos; 与数字实体 &#xNN; / &#NN;。
const ENTITY_MAP = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY_MAP[ent.toLowerCase()] ?? m;
  });
}

// 拼接一个字段内所有连续 CDATA 段的内容。
// 内容里含 ]]> 时，textReplyXml 会把 ]]> 断开成 ]]]]><![CDATA[>，
// 因此解析时同一个字段可能出现多个 CDATA 段，必须全部取出并拼接。
function concatCData(s) {
  let result = '';
  let i = 0;
  while (true) {
    const start = s.indexOf('<![CDATA[', i);
    if (start === -1) break;
    const innerStart = start + 9;
    const end = s.indexOf(']]>', innerStart);
    if (end === -1) break; // 未闭合的 CDATA：放弃后续拼接
    result += s.slice(innerStart, end);
    i = end + 3;
  }
  return result;
}

// 解析微信回调的扁平 XML → 普通对象。
// 微信推送结构固定：外层 <xml>，子元素为 <Tag><![CDATA[...]]></Tag> 或 <Tag>纯文本</Tag>。
// 规则：
//  - <![CDATA[...]]> 内容原样取出（不解析实体，CDATA 本就不转义）；多个 CDATA 段拼接；
//  - 纯文本字段做实体解码；
//  - 同一标签重复出现时保留首个（微信不会重复，这里取先到的即可）。
// 手写扫描、不引第三方库；解析失败返回空对象，由路由层兜底。
export function parseXml(text) {
  if (typeof text !== 'string') return {};
  const result = {};

  // 剥掉外层 <xml>...</xml>（若存在），否则整个文本按子元素扫描。
  let body = text;
  const rootMatch = text.match(/<xml[^>]*>([\s\S]*?)<\/xml>/i);
  if (rootMatch) body = rootMatch[1];

  // 扁平结构：每个子元素都是 <Tag>content</Tag>，content 内不再嵌套同名标签。
  // CDATA 里可以出现普通 < > 字符，但不会出现 </Tag>（CDATA 只被 ]]> 终止）。
  const tagRe = /<([A-Za-z][\w.-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const name = m[1];
    const content = m[3];
    if (content.includes('<![CDATA[')) {
      // 字段以 CDATA 为主：取出所有 CDATA 段拼接（含 ]]> 断开的情况）
      if (!(name in result)) result[name] = concatCData(content);
      continue;
    }
    if (!(name in result)) result[name] = decodeEntities(content);
  }
  return result;
}

// CDATA 内容转义：内容里出现 ]]> 时要断开 CDATA 再拼接，
// 否则 XML 解析器会把内容截断。标准做法是把 ]]> 换成 ]]]]><![CDATA[>。
function escapeCData(s) {
  return s.replace(/]]>/g, ']]]]><![CDATA[>');
}

// 生成文本类型的被动回复 XML。
// 字段顺序按微信文档：ToUserName=用户 openid，FromUserName=公众号原始 ID，
// CreateTime 用秒级时间戳。content 用 CDATA 包裹并断开 ]]>。
export function textReplyXml({ toUser, fromUser, content, now = Date.now }) {
  const ts = typeof now === 'function' ? now() : now;
  const createTime = Math.floor(ts / 1000);
  const to = String(toUser ?? '');
  const from = String(fromUser ?? '');
  const body = String(content ?? '');
  return (
    '<xml>' +
    `<ToUserName><![CDATA[${escapeCData(to)}]]></ToUserName>` +
    `<FromUserName><![CDATA[${escapeCData(from)}]]></FromUserName>` +
    `<CreateTime>${createTime}</CreateTime>` +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${escapeCData(body)}]]></Content>` +
    '</xml>'
  );
}
