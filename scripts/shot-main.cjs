// Electron 截图主进程（CommonJS）。
//
// 职责：创建隐藏 BrowserWindow，先登录拿到会话，再按 jobs 逐页
// loadURL → 等渲染完成 → 注入 CSS（隐藏滚动条/光标）→ capturePage() → 写 PNG。
//
// 为什么隐藏窗口（show:false）：capturePage 对未显示窗口依然可用，且截图内容
// 与可见时一致；隐藏还能避免截图过程被用户看到、避免抢焦点。
//
// 为什么 2x：force-device-scale-factor=2 让 devicePixelRatio=2，capturePage 返回
// 2880×1800 的位图（1440×900 的 2 倍），规范要求「只出 2x」。
//
// 输入（环境变量，由 shots.mjs 注入）：
//   SHOT_BASE   服务基址，如 http://127.0.0.1:3060
//   SHOT_OUT    输出目录
//   SHOT_JOBS   JSON 数组 [{ seq, label, route|null, dynamic? }]
//   APP_PASSWORD 登录口令
//
// 输出：逐张写 PNG，末尾打印一行 __SHOTS_RESULT__ {...}，供编排脚本解析。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// 设备像素比必须在 ready 之前通过命令行开关生效；放在 whenReady 回调里
// 已经太晚（窗口/GPU 已初始化），会退回系统缩放。2x 是规范要求（只出 2x）。
app.commandLine.appendSwitch("force-device-scale-factor", "2");

const BASE = process.env.SHOT_BASE || "http://127.0.0.1:3060";
const OUT = process.env.SHOT_OUT || path.join(process.cwd(), "shots");
const JOBS = JSON.parse(process.env.SHOT_JOBS || "[]");
const PASSWORD = process.env.APP_PASSWORD || "";

// 页面加载后的额外等待：字体/动画/图表需要一点时间才稳定。规范建议 300–500ms，
// 这里取 800ms 更稳（首屏常有大图与进场动画）。
const SETTLE_MS = 800;

// 截图前注入的 CSS：隐藏滚动条（右侧灰边）、光标透明（闪烁竖线）、禁用动画。
// 为什么禁动画：动画会把首帧冻在「淡入一半」上，且会让 PNG 体积暴涨。
const INJECT_CSS = `
  html, body { scrollbar-width: none !important; }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  *, *::before, *::after {
    caret-color: transparent !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

// 登录后从列表接口取第一篇稿件的 id（供「正文编辑器」这类需要具体 id 的动态路线用）。
// 不为此造真实数据：库里没有稿件就返回 null，调用方跳过该页并在汇总里说明。
async function firstProjectId(win) {
  try {
    const res = await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${BASE}/api/projects`)}).then(r => r.ok ? r.json() : {projects:[]}).catch(() => ({projects:[]}))`,
    );
    const projects = Array.isArray(res?.projects) ? res.projects : [];
    return projects.length > 0 ? projects[0].id : null;
  } catch {
    return null;
  }
}

/** 逐页截图。单页失败不中断整批：记进 results，最后统一汇总。 */
async function shootAll(win) {
  const results = [];
  for (const job of JOBS) {
    const { seq, label, route } = job;
    try {
      // 动态路线：正文编辑器需要具体稿件 id。
      let target = route;
      if (!target) {
        const id = await firstProjectId(win);
        if (!id) {
          results.push({ seq, label, ok: false, skipped: true, error: "需要真实稿件 id，库里当前没有稿件，跳过" });
          continue;
        }
        target = `/projects/${id}`;
      }

      const url = `${BASE}${target}`;
      await win.loadURL(url);

      // 等渲染完成（did-finish-load 已由 loadURL 保证），再等动画/字体稳定。
      await delay(SETTLE_MS);

      // 注入截图前置 CSS + 让焦点离开输入框（避免光标竖线）。
      await win.webContents.executeJavaScript(`(() => {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        const style = document.getElementById('__shot_css__');
        if (!style) {
          const el = document.createElement('style');
          el.id = '__shot_css__';
          el.textContent = ${JSON.stringify(INJECT_CSS)};
          document.head.appendChild(el);
        }
        return true;
      })()`);

      // 再等一拍，让 CSS 与 blur 生效。
      await delay(60);

      const image = await win.webContents.capturePage();
      const file = shotFile(seq, label, image.getSize());
      await fs.promises.writeFile(file, image.toPNG());
      const size = fs.statSync(file).size;
      results.push({ seq, label, ok: true, file, size });
      console.log(`[shot] ${seq} ${label} ✓ ${file}`);
    } catch (error) {
      results.push({
        seq,
        label,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[shot] ${seq} ${label} ✗`, error);
    }
  }
  return results;
}

/** 命名严格按规范：<两位序号>-<场景>-<宽>x<高>@<倍数>.png。 */
function shotFile(seq, label, size) {
  const w = size?.width ?? 1440;
  const h = size?.height ?? 900;
  return path.join(OUT, `${seq}-${label}-${w}x${h}@2x.png`);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(async () => {
  // 输出目录必须存在，否则 capturePage 落盘会 ENOENT（shots/ 不进版本库，首跑不存在）。
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    // useContentSize：宽高指内容区而非窗口外框，避免系统标题栏把内容区挤小。
    webPreferences: { offscreen: false, nodeIntegration: false },
  });

  // 实测（本机 125% 显示缩放 + 2x）发现：仅用 width/height 构造时，Electron 会把
  // 构造参数按系统缩放错误换算成内容区 951×492 DIP（而非 1440×900），导致截图
  // 只有 1902×984 物理像素。用 setContentSize 显式指定内容区 DIP，配合顶部
  // force-device-scale-factor=2，才能得到精确的 1440×900 CSS → 2880×1800 物理。
  // 注意：setContentSize 有 +1 DIP 的系统偏差，传 (1439,899) 实际内容区才是 1440×900。
  win.setContentSize(1439, 899);
  await new Promise((r) => setTimeout(r, 200));

  // 屏蔽 devtools 之外的调试噪音；页面本身不该往控制台打东西。
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log(`[renderer] ${message}`);
  });

  try {
    // 先登录：桌面版启动即注入会话，但这里从零拉起（无 cookie），必须显式登录。
    await win.loadURL(`${BASE}/login`);
    await delay(300);
    const loginRes = await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${BASE}/api/auth/login`)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} }),
      }).then(r => r.json().then(body => ({ ok: r.ok, status: r.status, text: body.error || "" })).catch(() => ({ ok: r.ok, status: r.status, text: "" })))`,
    );
    const loginText = loginRes.text || "";
    if (!loginRes.ok) {
      throw new Error(`登录失败（HTTP ${loginRes.status}）：${loginText}`);
    }
    console.log("[shot] 登录成功");

    // 等登录跳转完成（登录页会 router.replace('/')）。
    await delay(500);

    const results = await shootAll(win);

    // 汇总结果交给编排脚本解析。
    console.log(`__SHOTS_RESULT__ ${JSON.stringify({ ok: results.every((r) => r.ok), results })}`);
  } catch (error) {
    console.error("[shot] 致命错误：", error);
    console.log(
      `__SHOTS_RESULT__ ${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), results: [] })}`,
    );
  } finally {
    win.destroy();
    app.quit();
  }
});

// 超时兜底：某个页面卡死时不至于永远挂着。
setTimeout(() => {
  console.error("[shot] 全局超时（120s），强制退出。");
  app.exit(1);
}, 120_000);
