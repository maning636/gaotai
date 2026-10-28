// /privacy 隐私说明页
//
// 为什么单独一页：领码要收集邮箱，属于个人信息处理，必须有明示告知。
// 页面只写系统真实做的事——审计日志记什么、不记什么，都在这里对齐，
// 免得日后和实际行为不一致，那比没有这页更糟。

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>隐私说明</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
     background:#f5f5f7;color:#1d1d1f;line-height:1.75;padding:28px 20px 64px}
.wrap{max-width:620px;margin:0 auto;background:#fff;border-radius:16px;padding:32px 24px;box-shadow:0 2px 16px rgba(0,0,0,.06)}
h1{font-size:20px;margin-bottom:6px}
.meta{font-size:13px;color:#86868b;margin-bottom:24px}
h2{font-size:15px;margin:22px 0 8px}
p,li{font-size:14px;color:#333}
ul{padding-left:20px;margin:6px 0}
li{margin:4px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f5f7;padding:1px 5px;border-radius:4px;font-size:13px}
.foot{margin-top:28px;padding-top:16px;border-top:1px solid #e5e5ea;font-size:13px;color:#86868b}
a{color:#0071e3;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <h1>隐私说明</h1>
  <p class="meta">适用于本页所属产品的注册码领取与激活。最后更新：2026-10-29。</p>

  <h2>我们收集什么</h2>
  <ul>
    <li><strong>邮箱</strong>：你领取注册码时填写的那一个。这是唯一由你主动提供的个人信息。</li>
    <li><strong>机器码</strong>：激活时由客户端根据本机硬件信息计算出的哈希值（64 位十六进制）。它无法反推出你的设备型号、序列号或任何文件内容。</li>
    <li><strong>IP 地址</strong>：服务端为限流与安全审计自动记录，随日志保留，不用于识别个人。</li>
    <li><strong>微信 openid</strong>：通过服务号领取注册码时，微信会提供你的 openid 作为身份标识，我们用它发放与去重注册码，不获取你的昵称、头像或手机号。</li>
  </ul>

  <h2>用来做什么</h2>
  <ul>
    <li>发放注册码，并在你再次领取时返回同一个码（避免重复占用）。</li>
    <li>把注册码与一台机器绑定，实现「一码一机」。</li>
    <li>在你反馈问题、或需要找回注册码时联系你。</li>
  </ul>

  <h2>我们不做什么</h2>
  <ul>
    <li>不把邮箱或机器码提供给任何第三方，也不用于广告投放。</li>
    <li>不向你发送营销邮件。产品更新通过公众号发布，不占用你的邮箱。</li>
    <li>不读取、不上传你电脑上的任何稿件、素材或聊天记录。</li>
    <li>不在审计日志里记录完整邮箱或令牌：日志只记注册码前 4 位、IP、错误码和时间。</li>
  </ul>

  <h2>保存多久</h2>
  <ul>
    <li>邮箱与注册码绑定记录：随该注册码存续，用于续期与找回。</li>
    <li>审计日志：用于排查滥用，按 <code>data/audit.jsonl</code> 保留。</li>
    <li>你可以随时要求删除：删除后该注册码失效，需重新领取。</li>
  </ul>

  <h2>你的权利</h2>
  <p>你可以要求查询、更正或删除你的邮箱与绑定记录。在公众号里直接回复，或发邮件到下方地址即可，我会在合理时间内处理。</p>
  <p>如果你不同意本说明，请不要领取注册码；不领取也不影响你浏览本页。</p>

  <div class="foot">
    联系方式：<a href="mailto:184610138@qq.com">184610138@qq.com</a><br>
    本页面仅用于说明本产品的注册码服务，不构成对其他服务的承诺。
  </div>
</div>
</body>
</html>`;

export function privacyPageHtml() {
  return HTML;
}
