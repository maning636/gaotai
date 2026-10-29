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
import { loginPage, consolePage, notConfiguredPage, textsPage } from '../lib/admin-page.mjs';
import { generateCode, normalizeContact, isValidEmail } from '../lib/store.mjs';
import { clientIp } from '../lib/http.mjs';
import { loadWechatConfig, saveWechatConfig, DEFAULT_WECHAT_CONFIG } from '../lib/wechat-config.mjs';

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

// 字符串去重（保序），空串剔除。
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const t = String(s).trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// 把原始表单 body 构造成「草稿配置」用于校验失败后回显——保证用户刚输入的内容不丢。
// 与 parseTextsForm 不同，这里不做校验、尽量还原用户看到的样子（faq 保持字面 \n 文本）。
function draftFromBody(body) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const faqLines = [];
  for (const line of str(body.faq).split('\n')) {
    const l = line.trim();
    if (!l) continue;
    const eq = l.indexOf('=');
    if (eq < 0) {
      faqLines.push({ keywords: [], reply: l });
      continue;
    }
    faqLines.push({
      keywords: dedupe(l.slice(0, eq).split(',')),
      reply: l.slice(eq + 1).replace(/\\n/g, '\n'),
    });
  }
  const products = [];
  for (let i = 0; i < 6; i++) {
    const name = str(body[`p${i}_name`]).trim();
    if (!name) continue;
    products.push({
      key: str(body[`p${i}_key`]).trim() || name.toLowerCase().replace(/\s+/g, '-'),
      name,
      keywords: dedupe((str(body[`p${i}_keywords`]) || '').split(',')),
      issue: str(body[`p${i}_issue`]) === '1',
      url: str(body[`p${i}_url`]).trim(),
      replySuffix: str(body[`p${i}_suffix`]).trim(),
    });
  }
  return { welcome: str(body.welcome), fallback: str(body.fallback), faq: faqLines, products, menu: {} };
}

// 解析 /admin/texts 表单 → wechat 配置对象。
//
// 容错（后台是人手敲的）：
//  - faq：空行忽略；每行按「第一个 =」分割，左边是逗号分隔的关键词，右边是回复；
//    回复里字面 `\n`（反斜杠 n）转成真实换行；关键词去重。
//  - 产品：最多 6 行；名称为空整行忽略；关键词逗号分隔去重；key/suffix 从隐藏字段带回，
//    新行用名称派生 key（下划线化）；issue 由 checkbox 是否存在决定。
// 返回 { ok, config } 或 { ok:false, error }。
function parseTextsForm(body) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const welcome = str(body.welcome);
  const fallback = str(body.fallback);

  // ---- FAQ：每行 `关键词1,关键词2=回复`，`\n` 字面量 → 换行 ----
  const faq = [];
  const faqRaw = str(body.faq);
  for (const line of faqRaw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    const eq = l.indexOf('=');
    if (eq < 0) {
      return { ok: false, error: `关键词回复行缺少「=」：${l}` };
    }
    const kws = dedupe(l.slice(0, eq).split(','));
    if (kws.length === 0) {
      return { ok: false, error: `关键词回复行没有关键词：${l}` };
    }
    const reply = l.slice(eq + 1).replace(/\\n/g, '\n');
    faq.push({ keywords: kws, reply });
  }

  // ---- 产品：最多 6 行 ----
  const products = [];
  for (let i = 0; i < 6; i++) {
    const name = str(body[`p${i}_name`]).trim();
    if (!name) continue; // 空行忽略
    const keywords = dedupe((str(body[`p${i}_keywords`]) || '').split(','));
    if (keywords.length === 0) {
      return { ok: false, error: `产品「${name}」没有关键词` };
    }
    const key = str(body[`p${i}_key`]).trim() || name.toLowerCase().replace(/\s+/g, '-');
    products.push({
      key,
      name,
      keywords,
      issue: str(body[`p${i}_issue`]) === '1',
      url: str(body[`p${i}_url`]).trim(),
      replySuffix: str(body[`p${i}_suffix`]).trim(),
    });
  }
  if (products.length === 0) {
    return { ok: false, error: '至少要保留一个产品' };
  }

  return { ok: true, config: { welcome, fallback, faq, products } };
}

// 当前生效的 wechat 配置：从 store 的 config.wechat 取，加载时已保证字段齐全。
function currentWechatConfig(config) {
  return config && config.wechat && typeof config.wechat === 'object' ? config.wechat : DEFAULT_WECHAT_CONFIG;
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

    // ---- GET /admin/texts：登录后编辑文案与关键词 ----
    if (method === 'GET' && pathname === '/admin/texts') {
      const token = readCookie(req, COOKIE_NAME);
      const session = auth.verifySession(token);
      if (!session) {
        const err = url.searchParams.get('err') || '';
        sendHtml(res, loginPage({ error: err || undefined }));
        return;
      }
      const message = url.searchParams.get('msg') || '';
      const error = url.searchParams.get('err') || '';
      sendHtml(res, textsPage({ config: currentWechatConfig(config), message, error }));
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

    // POST /admin/texts：保存文案与关键词。
    // 解析 → saveWechatConfig 原子写 → 303 回 /admin/texts?msg=；
    // 校验失败回本页带错误并保留用户输入（用 ?err= 传错误信息即可，输入靠再次 GET 预填——
    // 失败时回 303 到 GET /admin/texts?err=...，用户改的内容不会丢，因为表单预填的是
    // 当前生效配置，而本次失败的内容并未落盘，仍是最新的未保存输入，符合「不要吞掉用户输入」）。
    if (pathname === '/admin/texts') {
      const body = await readBody(req);
      if (!body) {
        redirect(res, '/admin/texts?err=' + encodeURIComponent('请求格式不正确'));
        return;
      }
      const parsed = parseTextsForm(body);
      if (!parsed.ok) {
        // 校验失败：直接回同页（200）并显示错误，表单预填用户刚提交的内容（不丢输入）。
        sendHtml(res, textsPage({ config: draftFromBody(body), error: parsed.error }));
        return;
      }
      // 表单只改 welcome/fallback/faq/products，listKeywords 与 menu 沿用当前生效值，
      // 合并后校验结构再落盘。
      const merged = {
        ...currentWechatConfig(config),
        welcome: parsed.config.welcome,
        fallback: parsed.config.fallback,
        faq: parsed.config.faq,
        products: parsed.config.products,
      };
      const saved = saveWechatConfig(config.dataDir, merged);
      if (!saved.ok) {
        sendHtml(res, textsPage({ config: draftFromBody(body), error: saved.error }));
        return;
      }
      // 写成功后同步内存里的 config.wechat，让后续回调立即用新配置，无需重启。
      // 重新 load 一次保证字段齐全（深合并补齐默认值）。
      config.wechat = loadWechatConfig(config.dataDir).config;
      store.appendAudit({ ip, codePrefix: '', errorCode: '', event: 'admin:texts' });
      redirect(res, '/admin/texts?msg=' + encodeURIComponent('已保存，文案与关键词已生效'));
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
