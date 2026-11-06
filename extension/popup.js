// 稿台多平台分发 · Popup
//
// 打开时向 background 查询连接状态并渲染。background 维护真实状态，
// popup 只读不写——连接逻辑全在 service worker 里，popup 关掉不受影响。

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const hint = document.getElementById("hint");

function render(state) {
  const connected = Boolean(state && state.connected);
  dot.className = connected ? "dot on" : "dot off";
  statusText.textContent = connected ? "已连接" : "未连接";
  hint.textContent = connected
    ? `已连上稿台（${state.port || "?"} 端口）。去稿台选平台并推送。`
    : "请确认稿台桌面版已启动。";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "gaotai:get-status" }, (state) => {
    if (chrome.runtime.lastError || !state) {
      render(null);
      return;
    }
    render(state);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();
  // 每 2 秒刷新一次，popup 常开时状态也能跟上。
  setInterval(refresh, 2000);
});
