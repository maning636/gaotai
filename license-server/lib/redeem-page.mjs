// /redeem 自包含 HTML 表单页
// 协议 §6.2：无外部 JS/CSS，提交到 /v1/redeem，成功后显示注册码与复制按钮
// 移动端友好，不出现「免费」以外的多余营销话术

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>领取注册码</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f5f7;color:#1d1d1f;line-height:1.5;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:420px;background:#fff;border-radius:16px;padding:32px 24px;box-shadow:0 2px 16px rgba(0,0,0,.06)}
h1{font-size:20px;font-weight:600;text-align:center;margin-bottom:8px}
.desc{font-size:14px;color:#86868b;text-align:center;margin-bottom:24px}
label{display:block;font-size:14px;color:#1d1d1f;margin-bottom:8px}
input[type=text]{width:100%;height:44px;border:1px solid #d2d2d7;border-radius:10px;padding:0 12px;font-size:16px;background:#fff;outline:none;transition:border-color .2s}
input[type=text]:focus{border-color:#0071e3}
button{width:100%;height:44px;margin-top:20px;border:none;border-radius:10px;background:#0071e3;color:#fff;font-size:16px;font-weight:500;cursor:pointer;transition:opacity .2s}
button:disabled{opacity:.5;cursor:not-allowed}
button:active{opacity:.8}
.result{margin-top:24px;text-align:center;display:none}
.result .label{font-size:13px;color:#86868b;margin-bottom:8px}
.result .code{font-size:22px;font-weight:600;letter-spacing:1px;color:#0071e3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;padding:12px;background:#f5f5f7;border-radius:10px;user-select:all}
.result .copy{margin-top:12px;height:36px;font-size:14px;background:#34c759}
.err{margin-top:16px;font-size:13px;color:#ff3b30;text-align:center;min-height:18px}
.hint{margin-top:24px;font-size:12px;color:#86868b;text-align:center}
</style>
</head>
<body>
<div class="card">
  <h1>领取注册码</h1>
  <p class="desc">填写微信号或手机号，免费领取一份注册码</p>
  <form id="f">
    <label for="c">微信号 / 手机号</label>
    <input id="c" name="contact" type="text" autocomplete="off" placeholder="例如 wx_xxxx 或 138xxxxxxxx" required>
    <button id="b" type="submit">领取</button>
    <p class="err" id="e"></p>
  </form>
  <div class="result" id="r">
    <p class="label">你的注册码（请妥善保存）</p>
    <p class="code" id="code"></p>
    <button class="copy" id="copy" type="button">复制注册码</button>
  </div>
  <p class="hint">同一微信号或手机号重复领取将返回同一个注册码</p>
</div>
<script>
var errMap={
  "bad_contact":"联系方式格式不正确",
  "rate_limited":"领取过于频繁，请稍后再试",
  "bad_request":"请求格式不正确",
  "internal":"服务暂时不可用，请稍后再试"
};
var $=function(id){return document.getElementById(id)};
$("f").addEventListener("submit",function(ev){
  ev.preventDefault();
  var btn=$("b"),err=$("e"),res=$("r");
  err.textContent="";res.style.display="none";btn.disabled=true;btn.textContent="领取中…";
  var contact=$("c").value.trim();
  if(contact.length<2){err.textContent=errMap["bad_contact"];btn.disabled=false;btn.textContent="领取";return}
  fetch("/v1/redeem",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({contact:contact,channel:"direct"})
  }).then(function(r){return r.json().then(function(j){return{status:r.status,json:j}})})
  .then(function(o){
    var j=o.json;
    if(j&&j.ok&&j.data&&j.data.code){
      $("code").textContent=j.data.code;
      res.style.display="block";
      btn.textContent="已领取";btn.disabled=true;
    }else{
      var code=(j&&j.error&&j.error.code)||"internal";
      err.textContent=errMap[code]||errMap["internal"];
      btn.disabled=false;btn.textContent="领取";
    }
  }).catch(function(){
    err.textContent=errMap["internal"];btn.disabled=false;btn.textContent="领取";
  });
});
$("copy").addEventListener("click",function(){
  var text=$("code").textContent;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){flash()}).catch(fallback);
  }else{fallback()}
  function fallback(){
    var ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();
    try{document.execCommand("copy");flash()}catch(e){}
    document.body.removeChild(ta);
  }
  function flash(){var b=$("copy");var t=b.textContent;b.textContent="已复制";setTimeout(function(){b.textContent=t},1500)}
});
</script>
</body>
</html>`;

export function redeemPageHtml() {
  return HTML;
}
