// 网页后台的自包含 HTML 页面：登录页与控制台。
//
// 视觉沿用现有 redeem/privacy 页的白卡片 + 圆角 + 蓝色主按钮 + 系统字体，
// 不另起一套视觉，运维在手机/桌面看到的是同一个产品语言。
// 无外部资源（无 CDN/字体/JS 库），离线也能渲染。
//
// 注意：页面由模板字符串拼出，**不能写带反斜杠的正则**——会被当成转义吞掉
// 导致 JS 语法错误（见 redeem-page.mjs 顶部的注释）。本页刻意不写任何脚本
// 正则，全部用表单原生行为，避免这个坑。
//
// 安全：所有从数据里取出的字符串（contact/note/code 等）都要 HTML 转义，
// 防止存库内容里夹带 <script> 打到页面上（XSS）。

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 时间戳 → 本地可读字符串；空值显示「从未」。
function fmtTime(ts) {
  if (!ts || typeof ts !== 'number') return '从未';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '从未';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const BASE_STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
     background:#f5f5f7;color:#1d1d1f;line-height:1.6;padding:20px 16px 64px}
.wrap{max-width:760px;margin:0 auto}
.card{background:#fff;border-radius:16px;padding:24px 20px;box-shadow:0 2px 16px rgba(0,0,0,.06);margin-bottom:16px}
h1{font-size:20px;font-weight:600;margin-bottom:6px}
.desc{font-size:14px;color:#86868b;margin-bottom:20px}
label{display:block;font-size:14px;margin:12px 0 6px}
input,select,textarea{width:100%;height:44px;border:1px solid #d2d2d7;border-radius:10px;padding:0 12px;
     font-size:16px;background:#fff;outline:none;transition:border-color .2s}
input:focus,select:focus,textarea:focus{border-color:#0071e3}
textarea{height:auto;min-height:64px;padding:8px 12px;resize:vertical}
button{height:44px;border:none;border-radius:10px;background:#0071e3;color:#fff;font-size:16px;
     font-weight:500;cursor:pointer;transition:opacity .2s}
button:active{opacity:.8}
button[disabled]{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:8px;flex-wrap:wrap}
.row>button,.row>input,.row>select{flex:1;min-width:0}
.banner{margin-bottom:16px;padding:12px 14px;border-radius:10px;font-size:14px}
.banner.ok{background:#e8f8ee;color:#137333}
.banner.err{background:#fdeceb;color:#c5221f}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e5e5ea;vertical-align:top}
th{font-size:13px;color:#86868b;font-weight:500;white-space:nowrap}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
.muted{color:#86868b;font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
.badge.on{background:#e8f8ee;color:#137333}
.badge.off{background:#fdeceb;color:#c5221f}
.badge.bound{background:#eef4ff;color:#0a58ca}
.inline{display:inline}
.inline button{height:32px;padding:0 10px;font-size:13px;border-radius:8px}
.inline .btn-danger{background:#ff3b30}
.inline .btn-muted{background:#86868b}
.inline .btn-restore{background:#34c759}
.hint{font-size:12px;color:#86868b;margin-top:6px}
.empty{text-align:center;color:#86868b;padding:32px 0;font-size:14px}
.search-row{display:flex;gap:8px;margin-bottom:16px}
.search-row input{flex:1}
.search-row button{width:auto;padding:0 20px;flex:0 0 auto}
`;

function pageShell({ title, body }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
<div class="wrap">${body}</div>
</body>
</html>`;
}

// 登录页：口令输入 + 提交到 POST /admin/login。
// 未配置口令时由路由层直接给 503 页（见 adminNotConfiguredPage），不会走到这里。
export function loginPage({ error } = {}) {
  const banner = error
    ? `<div class="banner err">${escapeHtml(error)}</div>`
    : '';
  const body = `
<div class="card">
  <h1>后台登录</h1>
  <p class="desc">输入管理口令进入发码控制台</p>
  ${banner}
  <form method="post" action="/admin/login">
    <label for="pw">管理口令</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit" style="width:100%;margin-top:20px">登录</button>
  </form>
</div>`;
  return pageShell({ title: '后台登录', body });
}

// 未配置口令时的提示页（503）。
export function notConfiguredPage() {
  const body = `
<div class="card">
  <h1>后台不可用</h1>
  <div class="banner err">未配置后台口令（ADMIN_PASSWORD）。请在服务器环境变量里设置后重启。</div>
  <p class="hint">出于安全考虑，未配置口令时后台不提供任何入口，绝不降级为「无口令可进」。</p>
</div>`;
  return pageShell({ title: '后台不可用', body });
}

// 控制台：发码表单 + 搜索 + 列表。
// codes 是 store.listCodes() 的结果（含 revoked 等字段）。
export function consolePage({ codes, query, message, error } = {}) {
  const banner = message
    ? `<div class="banner ok">${escapeHtml(message)}</div>`
    : error
      ? `<div class="banner err">${escapeHtml(error)}</div>`
      : '';
  const q = (query || '').trim();

  const issueForm = `
<div class="card">
  <h1>发码</h1>
  <p class="desc">同邮箱重复发放会返回原码（幂等）</p>
  <form method="post" action="/admin/action">
    <input type="hidden" name="action" value="issue">
    <label for="contact">邮箱</label>
    <input id="contact" name="contact" type="email" inputmode="email" placeholder="name@example.com" required>
    <label for="note">备注</label>
    <textarea id="note" name="note" placeholder="可选，如渠道或客户名"></textarea>
    <label for="maxDevices">最大设备数</label>
    <input id="maxDevices" name="maxDevices" type="number" min="1" max="10" value="1">
    <button type="submit" style="width:100%;margin-top:20px">发放注册码</button>
  </form>
</div>`;

  const searchBar = `
<form method="get" action="/admin" class="search-row">
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="搜索邮箱或注册码前缀">
  <button type="submit">搜索</button>
</form>`;

  let rows;
  if (!codes || codes.length === 0) {
    rows = `<div class="empty">${q ? '没有匹配的注册码' : '暂无注册码，先在上面发放一个'}</div>`;
  } else {
    const trs = codes.map((c) => {
      const code = escapeHtml(c.code || '');
      const contact = escapeHtml(c.contact || '');
      const note = escapeHtml(c.note || '');
      const revoked = !!c.revoked;
      const devices = Array.isArray(c.devices) ? c.devices.length : 0;
      const max = c.maxDevices || 1;
      const lastSeen = fmtTime(c.lastSeenAt);
      const createdAt = fmtTime(c.createdAt);
      const statusBadge = revoked
        ? `<span class="badge off">已吊销</span>`
        : `<span class="badge on">正常</span>`;
      const boundBadge = `<span class="badge bound">${devices}/${max} 台</span>`;

      // 行内操作按钮：吊销/恢复互斥；解绑只在有多台设备时给（单机码解绑=清除绑定，也常见，
      // 但约定按需求只在 >1 台时显示，避免误触清空一台机的绑定）。
      const actions = revoked
        ? `<form class="inline" method="post" action="/admin/action">
             <input type="hidden" name="action" value="unrevoke">
             <input type="hidden" name="code" value="${code}">
             <button type="submit" class="btn-restore">恢复</button>
           </form>`
        : `<form class="inline" method="post" action="/admin/action">
             <input type="hidden" name="action" value="revoke">
             <input type="hidden" name="code" value="${code}">
             <button type="submit" class="btn-danger">吊销</button>
           </form>
           ${devices > 1
             ? `<form class="inline" method="post" action="/admin/action">
                 <input type="hidden" name="action" value="unbind">
                 <input type="hidden" name="code" value="${code}">
                 <button type="submit" class="btn-muted">解绑</button>
               </form>`
             : ''}`;

      return `<tr>
  <td><span class="mono">${code}</span> ${statusBadge}</td>
  <td>${contact}<div class="muted">${note}</div></td>
  <td class="muted">${createdAt}</td>
  <td>${boundBadge}</td>
  <td class="muted">${lastSeen}</td>
  <td class="inline">${actions}</td>
</tr>`;
    }).join('');
    rows = `<table>
<thead><tr><th>注册码</th><th>邮箱 / 备注</th><th>领取时间</th><th>绑定</th><th>最后在线</th><th>操作</th></tr></thead>
<tbody>${trs}</tbody></table>`;
  }

  const body = `
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div>
      <h1>发码控制台</h1>
      <p class="desc" style="margin-bottom:0">注册码共 ${Array.isArray(codes) ? codes.length : 0} 条${q ? `，筛选 “${escapeHtml(q)}”` : ''}</p>
    </div>
    <form method="post" action="/admin/logout">
      <button type="submit" class="btn-muted" style="height:36px;padding:0 16px;font-size:13px">退出登录</button>
    </form>
  </div>
</div>
${banner}
${issueForm}
${searchBar}
<div class="card">${rows}</div>`;
  return pageShell({ title: '发码控制台', body });
}
