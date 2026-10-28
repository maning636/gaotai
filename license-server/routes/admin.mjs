// 网页后台路由：GET /admin、POST /admin/login、POST /admin/logout、POST /admin/action。
//
// 安全要点（与 http.mjs 的协议层区分开）：
//  - 未配置 ADMIN_PASSWORD → 所有 /admin 一律 503，绝无「无口令可进」；
//  - 会话 cookie 名 gt_admin，HttpOnly + SameSite=Strict + Path=/admin，HTTPS 加 Secure；
//  - 所有写操作做 Origin/Referer 同源校验（不一致 403），配合 SameSite=Strict 防 CSRF；
//  - 未登录访问任何 /admin* 的 POST → 401；
//  - 口令失败限流：同 IP 5 分钟 5 次失败锁 5 分钟（进程内，见 admin-auth.mjs）。
//
// 返回约定：HTML 页直接 200；登录/动作成功用 303 跳回 /admin 并带 ?msg=，
// 失败留在原页显示错误（不把用户踢回登录页）。

import { createAdminAuth } from '../lib/admin-auth.mjs';
import { loginPage, consolePage, notConfiguredPage } from '../lib/admin-page.mjs';
import { generateCode, normalizeContact, isValidEmail } from '../lib/store.mjs';
import { clientIp } from '../lib/http.mjs';

const COOKIE_NAME = 'gt_admin';
const SESSION_COOKIE_TTL = 12 * 60 * 60; // 秒，与 admin-auth 的令牌有效期一致

// 读 cookie 里的会话令牌
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

// 表单（application/x-www-form-urlencoded）或 JSON 都接受 → 返回普通对象。
// 解析失败返回 null（调用方按 400 处理）。
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
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
        return;
      }
      // 默认按表单解析
      const params = new URLSearchParams(raw);
      const obj = {};
      for (const [k, v] of params) {
        obj[k] = v;
      }
      resolve(obj);
    });
    req.on('error', () => resolve(null));
  });
}

// Origin/Referer 同源校验：两者与请求 Host 同源才放行。
// 无 Origin/Referer（curl、同源 GET 导航）视为同源——SameSite=Strict cookie
// 已经挡住跨站带 cookie 的请求，这里再兜一层显式校验。
function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === host;
  } catch {
    return false;
  }
}

function sendHtml(res, html, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(html));
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

function redirect(res, location, status = 303) {
  res.statusCode = status;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function setSessionCookie(res, token, secure) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/admin',
    `Max-Age=${SESSION_COOKIE_TTL}`,
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res, secure) {
  const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/admin', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// 是否 HTTPS：由 X-Forwarded-Proto 或 TSL 直接判定。nginx 反代会带 X-Forwarded-Proto。
function isSecure(req, trustProxy) {
  if (trustProxy) {
    const proto = req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto === 'https') return true;
  }
  return !!req.socket.encrypted;
}

export function createAdminRoute({ config, store, randomInt, now }) {
  // 口令与会话密钥来自环境变量；adminAuth 内部处理「未配置密钥用随机」。
  const auth = createAdminAuth({
    password: config.adminPassword,
    sessionSecret: config.adminSessionSecret,
    now,
  });

  async function handle(req, res, url) {
    const pathname = url.pathname;
    const method = req.method;
    const ip = clientIp(req, config.trustProxy);
    const secure = isSecure(req, config.trustProxy);

    // 未配置口令：任何 /admin* 一律 503（登录页也不给，避免暴露表单）。
    if (!auth.configured) {
      if (method === 'GET') {
        sendHtml(res, notConfiguredPage(), 503);
      } else {
        res.statusCode = 503;
        res.end('not configured');
      }
      return;
    }

    // ---- GET /admin：登录页 或 控制台 ----
    if (method === 'GET' && pathname === '/admin') {
      const token = readCookie(req, COOKIE_NAME);
      const session = auth.verifySession(token);
      if (!session) {
        // 未登录：显示登录页（可带错误提示，通过 ?err= 传入）
        const err = url.searchParams.get('err') || '';
        sendHtml(res, loginPage({ error: err || undefined }));
        return;
      }
      // 已登录：搜索 + 列表
      const q = (url.searchParams.get('q') || '').trim();
      const all = await store.listCodes();
      let codes = all;
      if (q) {
        const lower = q.toLowerCase();
        codes = all.filter(
          (c) =>
            (c.contact && c.contact.toLowerCase().includes(lower)) ||
            (c.code && c.code.toLowerCase().includes(lower)),
        );
      }
      // 按领取时间倒序，新发的排前面
      codes = codes.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const message = url.searchParams.get('msg') || '';
      const error = url.searchParams.get('err') || '';
      sendHtml(res, consolePage({ codes, query: q, message, error }));
      return;
    }

    // ---- 写操作：登录本身例外，其余都要先有会话 ----
    if (method !== 'POST') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }

    // 同源校验：跨站 Origin/Referer → 403。登录请求也要过（防登录 CSRF，
    // 攻击者拿自己口令把受害者登进攻击者的会话），不依赖 cookie。
    if (!sameOrigin(req)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }

    // POST /admin/login：口令登录（允许表单或 JSON）。
    // 未登录用户唯一能走的 POST，故放在会话检查之前。
    if (pathname === '/admin/login') {
      const body = await readBody(req);
      if (!body) {
        sendHtml(res, loginPage({ error: '请求格式不正确' }));
        return;
      }
      // 限流：已锁 → 直接拒绝，不再计数
      if (auth.isLocked(ip)) {
        sendHtml(res, loginPage({ error: '失败次数过多，请 5 分钟后再试' }));
        return;
      }
      const plain = typeof body.password === 'string' ? body.password : '';
      if (!auth.verifyPassword(plain)) {
        auth.recordFail(ip);
        if (auth.isLocked(ip)) {
          sendHtml(res, loginPage({ error: '失败次数过多，请 5 分钟后再试' }));
        } else {
          sendHtml(res, loginPage({ error: '口令不正确' }));
        }
        return;
      }
      // 成功：清失败计数，发会话 cookie，303 回 /admin
      auth.reset(ip);
      const newToken = auth.issueSession();
      setSessionCookie(res, newToken, secure);
      redirect(res, '/admin');
      return;
    }

    // ---- 以下都需要已登录会话 ----
    const token = readCookie(req, COOKIE_NAME);
    const session = auth.verifySession(token);
    if (!session) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }

    // POST /admin/logout：清 cookie
    if (pathname === '/admin/logout') {
      clearSessionCookie(res, secure);
      redirect(res, '/admin');
      return;
    }

    // POST /admin/action：issue | revoke | unrevoke | unbind
    if (pathname === '/admin/action') {
      const body = await readBody(req);
      if (!body) {
        redirect(res, '/admin?err=' + encodeURIComponent('请求格式不正确'));
        return;
      }
      const action = typeof body.action === 'string' ? body.action : '';
      const rawCode = typeof body.code === 'string' ? body.code : '';
      const contact = typeof body.contact === 'string' ? body.contact : '';
      const note = typeof body.note === 'string' ? body.note : '';
      const maxDevices = parseInt(body.maxDevices, 10);

      // 校验 action 合法
      const ACTIONS = ['issue', 'revoke', 'unrevoke', 'unbind'];
      if (!ACTIONS.includes(action)) {
        redirect(res, '/admin?err=' + encodeURIComponent('未知操作'));
        return;
      }

      // 统一写审计：只记 code 前 7 位、IP、事件名（绝不含完整邮箱/口令）。
      const audit = (ev, codePrefix) =>
        store.appendAudit({ ip, codePrefix: codePrefix || (rawCode ? rawCode.slice(0, 7) : ''), errorCode: '', event: 'admin:' + ev });

      if (action === 'issue') {
        const normContact = normalizeContact(contact);
        if (!isValidEmail(normContact)) {
          audit('issue');
          redirect(res, '/admin?err=' + encodeURIComponent('邮箱格式不正确'));
          return;
        }
        const md = Number.isFinite(maxDevices) && maxDevices >= 1 && maxDevices <= 10 ? maxDevices : 1;
        const code = generateCode(store, randomInt, config.codeFormat);
        const record = await store.issueCode({
          code,
          contact: normContact,
          channel: 'direct',
          note: note.slice(0, 200),
          maxDevices: md,
        });
        audit('issue', record.code.slice(0, 7));
        redirect(res, '/admin?msg=' + encodeURIComponent(`已发放：${record.code}`));
        return;
      }

      // revoke / unrevoke / unbind 都要先解析出库里实际存的码（兼容旧格式）
      const resolved = store.resolveCode(rawCode);
      if (!resolved.code) {
        audit(action);
        redirect(res, '/admin?err=' + encodeURIComponent('注册码格式不正确'));
        return;
      }
      const code = resolved.code;
      if (!resolved.record) {
        audit(action);
        redirect(res, '/admin?err=' + encodeURIComponent('注册码不存在'));
        return;
      }
      if (action === 'revoke') {
        await store.revoke(code);
        audit(action, code.slice(0, 7));
        redirect(res, '/admin?msg=' + encodeURIComponent(`已吊销：${code}`));
        return;
      }
      if (action === 'unrevoke') {
        await store.unrevoke(code);
        audit(action, code.slice(0, 7));
        redirect(res, '/admin?msg=' + encodeURIComponent(`已恢复：${code}`));
        return;
      }
      if (action === 'unbind') {
        await store.unbind(code, undefined); // 解绑全部设备
        audit(action, code.slice(0, 7));
        redirect(res, '/admin?msg=' + encodeURIComponent(`已解绑：${code}`));
        return;
      }
    }

    res.statusCode = 404;
    res.end('not found');
  }

  return { handle, auth };
}
