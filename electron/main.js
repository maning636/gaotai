// Electron 主进程：负责窗口、原生菜单、以及驱动 Next.js 后端服务子进程。
// 关键约束：项目根目录没有 "type": "module"，本文件必须保持 CommonJS 语法。
const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain, clipboard } = require("electron");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");
const crypto = require("node:crypto");
// 浏览器扩展桥：本地 WS 服务端，供 Chrome 扩展连接、接收多平台分发任务。
const wsBridge = require("./ws-bridge");

// 运行模式：production（打包后）走 Next standalone 产物，dev（开发调试）走 next dev。
// 由 npm script 通过环境变量注入，默认按打包态处理。
const MODE = (process.env.GAOTAI_MODE || "production").toLowerCase();

// ── 本次启动的令牌 ───────────────────────────────────────────────────────────
//
// 每次启动随机生成，只通过环境变量交给后端子进程：**不落盘、不进 .env**。
//
// 它的唯一用途是：窗口打开前用它换一个会话，用户全程不用输任何东西。
// 令牌只对当次进程有效——被别的程序读到也换不出能用的会话，
// 而浏览器里的网页更拿不到它（后端只认进程环境变量里的那一份）。
const bootToken = crypto.randomBytes(32).toString("hex");

let mainWindow = null;
let backendService = null;
let backendPort = 0;
// 后端是否正在被我们主动关闭。用来区分「正常收工」和「后端自己崩了」。
let backendStopping = false;

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 用户双击快捷方式第二次时，只把已有窗口拉到前台，避免多份后端子进程互相踩端口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// ── 原生菜单 ─────────────────────────────────────────────────────────────────
// 只提供必要的实用项：重载窗口、打开数据/资源目录、关于。
function buildMenu(serviceUrl) {
  const template = [
    {
      label: "视图",
      submenu: [
        { label: "重新加载", accelerator: "CmdOrCtrl+R", click: () => mainWindow && mainWindow.reload() },
        { type: "separator" },
        { role: "resetZoom", label: "重置缩放" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "工具",
      submenu: [
        { label: "打开数据目录", click: () => shell.openPath(resolveDataDir()) },
        { label: "打开资源目录", click: () => shell.openPath(resolveResourceDir()) },
        { type: "separator" },
        {
          label: "显示本机口令",
          click: () => {
            const password = readLocalPassword();
            if (!password) {
              dialog.showMessageBox({
                type: "warning",
                message: "没有找到本机口令",
                detail: `用户数据目录里没有 .env，或其中缺少 APP_PASSWORD。\n目录：${resolveDataDir()}`,
                buttons: ["打开数据目录", "关闭"],
                defaultId: 0,
                cancelId: 1,
              }).then(({ response }) => {
                if (response === 0) shell.openPath(resolveDataDir());
              });
              return;
            }
            dialog
              .showMessageBox({
                type: "info",
                message: "本机登录口令",
                detail: password,
                buttons: ["复制到剪贴板", "打开数据目录", "关闭"],
                defaultId: 0,
                cancelId: 2,
              })
              .then(({ response }) => {
                if (response === 0) clipboard.writeText(password);
                if (response === 1) shell.openPath(resolveDataDir());
              });
          },
        },
        { type: "separator" },
        { label: "在浏览器中打开服务", click: () => shell.openExternal(serviceUrl) },
      ],
    },
    {
      label: "关于",
      role: "about",
      submenu: [],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ── 主窗口 ───────────────────────────────────────────────────────────────────
function createMainWindow() {
  const url = `http://127.0.0.1:${backendPort}`;
  Menu.setApplicationMenu(buildMenu(url));

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "稿台",
    backgroundColor: "#F2EFE6",
    // 先隐藏，等页面首帧就绪再显示，避免白屏闪烁。
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow && mainWindow.show());

  // 注意：这里不 loadURL。由 whenReady 中的调用方在注入 session cookie 之后显式 loadURL，
  // 否则 AuthGate 拿不到会话会被重定向到 /login，白白多一次跳转。
  // 只允许导航到本地后端地址；其它链接一律交给系统浏览器打开。
  // 只放行 http/https：其它协议（file:, javascript: 等）既不是我们要打开的下载页，
  // 也可能是被注入的伪协议，直接拒绝比交给系统浏览器更安全。
  const isLocalService = (u) => u.startsWith(`http://127.0.0.1:${backendPort}`);
  const isSafeExternal = (u) => /^https?:\/\//i.test(u);
  mainWindow.webContents.on("will-navigate", (event, u) => {
    if (!isLocalService(u)) {
      event.preventDefault();
      if (isSafeExternal(u)) shell.openExternal(u);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (!isLocalService(u) && isSafeExternal(u)) {
      // 「去下载新版本」按钮 window.open 的落地：交给系统浏览器，不在应用内开新窗。
      shell.openExternal(u);
    }
    return { action: "deny" };
  });

  mainWindow.on("close", () => logLifecycle("window close requested"));
  mainWindow.on("closed", () => {
    logLifecycle("window closed");
    mainWindow = null;
  });
}

// ── 自动登录 ─────────────────────────────────────────────────────────────────
// 桌面客户端没有可编辑的 .env，登录密码由 src/lib/bootstrap.ts 首次运行时生成，
// 并同时写入 <数据目录>/data/initial-password.txt（0600 权限）。Electron 读走后立刻删除，
// 避免密码长期留盘。第二次启动文件不存在时跳过自动登录，让用户看既有 Cookie 或登录页。
async function readInitialPassword() {
  const file = path.join(resolveDataDir(), "data", "initial-password.txt");
  if (!fs.existsSync(file)) return "";
  try {
    const password = fs.readFileSync(file, "utf8").trim();
    // 读取后立即删除，避免密码在磁盘上滞留。
    fs.unlinkSync(file);
    return password;
  } catch (error) {
    console.warn("[gaotai] 读取初始密码失败：", error && error.message);
    return "";
  }
}

// 只提取 name=value，其它属性（Path、Max-Age、HttpOnly、SameSite）Electron 会自行处理，
// 这里手工挑出 name 和 value 就够。任何形态的畸形输入都返回空数组，不抛异常。
function parseSetCookieHeaders(rawHeaders) {
  if (!rawHeaders) return [];
  // 数组元素本身已经是独立的 set-cookie 值，直接逐个拆；字符串再按 ", name=" 边界拆。
  // 不能用 "; " join —— 分号也是单条 cookie 的属性分隔符，会把下一条误当成属性。
  const lines = Array.isArray(rawHeaders) ? rawHeaders : String(rawHeaders).split(/,\s*(?=[A-Za-z0-9_][\w-]*=)/);
  const out = [];
  for (const line of lines) {
    const pair = line.split(";")[0].trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() });
  }
  return out;
}

// 把登录响应里的 session cookie 注入到浏览器默认会话，必须在 loadURL 之前调用。
//
// 必须显式给 expirationDate：不带它，Chromium 会当成「会话 cookie」，
// 只在本次运行内存活，程序一关就没了——于是用户每次启动都被弹回登录页，
// 而口令他根本没机会知道。给上 30 天（与服务端会话 TTL 一致），
// 用户装一次就能一直用。
const SESSION_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;

async function injectCookies(port, setCookieRaw) {
  const parsed = parseSetCookieHeaders(setCookieRaw);
  for (const { name, value } of parsed) {
    if (!name) continue;
    await session.defaultSession.cookies.set({
      url: `http://127.0.0.1:${port}`,
      name,
      value,
      httpOnly: true,
      path: "/",
      expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_TTL_SECONDS,
    });
  }
}

async function tryAutoLogin(port) {
  // 首选：本次启动的令牌。每次启动都走这一条，
  // 所以 30 天的会话过期对用户是不可见的——他永远不会被弹回登录页。
  if (await exchangeBootSession(port)) return;

  // 兜底：首启时写在磁盘上的那一份口令（读走即删）。
  // 只有后端没拿到启动令牌时才会走到这里。
  const password = await readInitialPassword();
  if (!password) return; // 非首启且没有令牌：静默跳过，让用户自己登录

  const loginUrl = `http://127.0.0.1:${port}/api/auth/login`;
  let res;
  try {
    res = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  } catch (err) {
    // 网络错误：自动登录只是便捷路径，不是必需路径，继续走 loadURL 让用户自己登录。
    console.warn("[gaotai] auto login fetch failed:", err && err.message);
    return;
  }

  if (!res.ok) {
    // 401（密码不匹配）、429（登录失败次数过多）等都静默降级到手动登录。
    console.warn(`[gaotai] auto login rejected: HTTP ${res.status}`);
    return;
  }

  await injectCookies(port, res.headers.get("set-cookie"));
}

// 用启动令牌换一个会话。成功返回 true。
async function exchangeBootSession(port) {
  const url = `http://127.0.0.1:${port}/api/auth/session`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: bootToken }),
    });
  } catch (err) {
    console.warn("[gaotai] boot session fetch failed:", err && err.message);
    return false;
  }
  if (!res.ok) {
    console.warn(`[gaotai] boot session rejected: HTTP ${res.status}`);
    return false;
  }
  await injectCookies(port, res.headers.get("set-cookie"));
  return true;
}

// ── 目录解析 ─────────────────────────────────────────────────────────────────
// 打包态与开发态使用不同的资源根；数据目录统一放在 Electron userData。
// 资源根是「包含 prompts/topics/skills 的那一层」：
//   开发态 = <项目根>/resources
//   打包态 = <安装目录>/resources/app-resources
// 与 src/lib/paths.ts 的 promptDir()/publicTopicsDir()/skillsDir() 严格对应。
function resolveResourceDir() {
  if (!app.isPackaged) return path.join(process.cwd(), "resources");
  return path.join(process.resourcesPath, "app-resources");
}
function resolveDataDir() {
  return app.getPath("userData");
}

// 浏览器扩展所在目录。
//
// Chrome/Edge 只认「加载已解压的扩展程序」，所以这里必须给用户一个真实文件夹，
// 不能是 asar 内部路径。打包态由 electron-builder 的 extraResources 落到
// <安装目录>/resources/extension；开发态直接用项目里的 extension/。
function resolveExtensionDir() {
  if (!app.isPackaged) return path.join(app.getAppPath(), "extension");
  return path.join(process.resourcesPath, "extension");
}

// 把扩展目录暴露给渲染进程，同时作为「打开文件夹」的动作入口。
// 走 IPC 而不是网页接口：本机任意程序都能打 HTTP，但只有本应用窗口能触发 IPC。
ipcMain.handle("gaotai:extension-dir", () => resolveExtensionDir());
ipcMain.handle("gaotai:open-extension-dir", async () => {
  const dir = resolveExtensionDir();
  const error = await shell.openPath(dir);
  return error ? { ok: false, error } : { ok: true, dir };
});

// 本机登录口令。
//
// 口令是首次运行时随机生成、随包自动登录的那一份，用户自己通常没看过。
// 没有这条找回路径的话：清了浏览器数据、换了机器、或者 30 天 cookie 过期，
// 用户就永久停在登录页外面，而口令既没显示过、initial-password.txt 也已删除。
function readLocalPassword() {
  try {
    const raw = fs.readFileSync(path.join(resolveDataDir(), ".env"), "utf8");
    const match = raw.match(/^\s*(?:export\s+)?APP_PASSWORD\s*=\s*(.+?)\s*$/m);
    if (!match) return "";
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
}

// 渲染进程通过 preload 桥调用这个接口取口令（见 electron/preload.js）。
ipcMain.handle("gaotai:reveal-local-password", () => readLocalPassword());

// 统一退出出口：先收后端，再立刻结束进程。
//
// 不用 app.quit()：它走完整退出流程，会被没关干净的窗口或子进程管道拖住，
// 结果是「窗口关了程序还在后台占着端口」。桌面客户端要的是「立刻、干净地走」。
function quitApp(code = 0) {
  logLifecycle(`quitApp(${code})`);
  try {
    cleanupBackend();
  } catch (err) {
    logStartupError("cleanupBackend failed", err);
  }
  try {
    wsBridge.stopWsBridge();
  } catch (err) {
    logStartupError("stopWsBridge failed", err);
  }
  // 留 300ms 让杀后端的命令真正跑起来。
  // 这里刻意不 unref：要让这个定时器把进程钉住，直到退出真正执行。
  setTimeout(() => {
    logLifecycle(`app.exit(${code})`);
    try {
      app.exit(code);
    } catch {
      /* 忽略：下面还有硬退兜底 */
    }
    // 兜底：app.exit() 会走 Chromium 的收尾流程，实测存在卡住不退出的时候
    // （窗口关了、主进程还活着、后端还占着端口）。
    // 1.5 秒后还活着就直接结束进程——窗口此时已经关掉，后端也已经同步杀掉了，
    // 剩下的只是 Chromium 自己的收尾，不值得为它把整个应用吊着。
    setTimeout(() => {
      logLifecycle("process.exit()");
      process.exit(code);
    }, 1500);
  }, 300);
}

// 启动期错误落盘：桌面版没有终端，弹窗一闪而过就查不到原因了。
function logStartupError(stage, error) {
  const detail = error && error.stack ? error.stack : String(error);
  console.error(`[gaotai] ${stage}:`, detail);
  try {
    const file = path.join(resolveDataDir(), "startup-error.log");
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${stage}\n${detail}\n\n`);
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

// 后端子进程的输出落盘。
//
// 为什么必须落盘：后端是独立子进程，出错时它的堆栈是唯一线索。
// 之前 stdio 用 "ignore"，装到用户机器后一旦后端起不来，
// 界面上只会看到一个空白页或登录页，错误完全不可见——
// 上一次排查「打包态 API 全 500」就是这么费的劲。
// 现在把 stdout/stderr 接到 <userData>/backend.log，并做体积上限，
// 免得长时间运行把日志撑爆用户硬盘。
function createBackendLogStream() {
  const file = path.join(resolveDataDir(), "backend.log");
  try {
    // 超过上限就清空重来：日志只在出问题时才有人看，不值得留历史包袱。
    const maxBytes = 2 * 1024 * 1024;
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.truncateSync(file, 0);
    return fs.createWriteStream(file, { flags: "a" });
  } catch {
    return null;
  }
}

// 退出流程的痕迹。
//
// 为什么单独记：这次踩过一个很隐蔽的坑——窗口关掉了，程序却没退出，
// 主进程和后端子进程都留在后台占着端口。桌面上看就是「关了还在」，
// 而且没有任何报错。把这几个节点写进日志，下次再犯就不用重新猜。
let lifecycleLog = null;
function logLifecycle(stage) {
  try {
    if (!lifecycleLog) {
      lifecycleLog = fs.createWriteStream(path.join(resolveDataDir(), "lifecycle.log"), { flags: "a" });
    }
    lifecycleLog.write(`[${new Date().toISOString()}] ${stage}\n`);
  } catch {
    /* 记不上也不影响主流程 */
  }
}

// 后端子进程的工作目录：Next standalone 以 process.cwd() 为基准寻找 public/ 与 .next/static，
// 因此必须指向 standalone 产物根，而不是 Electron 自身的工作目录。
function backendCwd() {
  if (MODE === "dev") return process.cwd();
  return path.dirname(standaloneServerPath());
}

// standalone 服务入口的绝对路径。
// 打包态：asarUnpack 释放到 app.asar.unpacked 的真实目录。
// 注意：不能用 app.asar 内部的路径——asar 只是虚拟文件系统，操作系统层面不存在该目录，
// 后端子进程以它为 cwd 启动时会直接 ENOENT 失败。
// 开发态：项目内构建产物 .next/standalone/server.js。
function standaloneServerPath() {
  if (!app.isPackaged) return path.join(app.getAppPath(), ".next", "standalone", "server.js");
  const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", ".next", "standalone", "server.js");
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(process.resourcesPath, "app.asar", ".next", "standalone", "server.js");
}

// ── 端口选择 ─────────────────────────────────────────────────────────────────
// 优先 GAOTAI_PORT；否则探测 127.0.0.1 上的空闲端口，避免与用户正在跑的 3050 撞车。
// 探测与真实绑定之间存在极小竞态窗口，任务书明确接受。
function pickPort() {
  const preferred = Number(process.env.GAOTAI_PORT || "");
  if (Number.isInteger(preferred) && preferred > 0 && preferred < 65536) return preferred;
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── 启动后端服务 ─────────────────────────────────────────────────────────────
// production：直接跑 Next standalone 产物（.next/standalone/server.js）。
// dev：跑 next dev，便于本地热重载联调。
// ELECTRON_RUN_AS_NODE 让 Electron 二进制退化为纯 Node，从而复用同一份 node_modules。
async function startBackend() {
  const port = await pickPort();
  backendPort = port;

  const baseEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    GAOTAI_DATA_DIR: resolveDataDir(),
    GAOTAI_RESOURCE_DIR: resolveResourceDir(),
    GAOTAI_EXTENSION_DIR: resolveExtensionDir(),
    // 本次启动的令牌：后端用它接受「桌面客户端自动换取会话」的请求。
    GAOTAI_BOOT_TOKEN: bootToken,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
  };

  // 授权旁路开关绝不能随打包产物分发：万一宿主环境被设了 GAOTAI_LICENSE_BYPASS，
  // 它会通过上面的 ...process.env 静默透传给后端子进程，等于把授权门禁整个关掉。
  // 这里显式剔除，保证安装包里的后端永远走真实校验。
  delete baseEnv.GAOTAI_LICENSE_BYPASS;

  let args;
  if (MODE === "dev") {
    baseEnv.NODE_ENV = "development";
    args = ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)];
  } else {
    // 打包态从 app.asar 里取 standalone 产物；开发机直接用项目内的构建产物。
    // 两者路径不同：开发态若也指向 resourcesPath，spawn 会因文件不存在而失败。
    args = [standaloneServerPath()];
  }
  const child = require("node:child_process").spawn(process.execPath, args, {
    env: baseEnv,
    // stdout/stderr 必须接管而不是 ignore：后端是独立进程，它的堆栈是排查的唯一线索。
    stdio: ["ignore", "pipe", "pipe"],
    // 让后端进程有自己的进程组，便于整棵子树一起终止。
    detached: true,
    // 工作目录必须指向 standalone 产物根：Next 会用 process.cwd() 找 public/ 与
    // .next/static，不设置的话会退回 Electron 的 cwd，导致样式和脚本全部 404。
    cwd: backendCwd(),
  });

  // 把后端输出同时送到日志文件和控制台。
  const logStream = createBackendLogStream();
  if (logStream) {
    child.stdout.on("data", (buf) => {
      logStream.write(buf);
      process.stdout.write(buf);
    });
    child.stderr.on("data", (buf) => {
      logStream.write(buf);
      process.stderr.write(buf);
    });
  }

  child.on("error", (err) => {
    logStartupError("backend spawn failed", err);
    dialog.showErrorBox("后端服务启动失败", err && err.stack ? err.stack : String(err));
    quitApp(1);
  });

  child.on("exit", (code, signal) => {
    // 后端是被我们主动杀掉的（正常退出），不该报警；
    // 只有「它自己没了」才需要留痕——那种情况界面会莫名其妙不能用。
    if (backendStopping) return;
    if (code !== 0 && code !== null) {
      logStartupError(`backend exited unexpectedly (code=${code}, signal=${signal})`, new Error("see above"));
    }
  });

  backendService = child;
  await waitForServiceReady(port, 60_000);
}

// 服务就绪探测：轮询 /api/auth/session，200（已登录）与 401（未登录）都说明 HTTP 层已起来。
// 超时 60 秒则弹窗退出——后端起不来整个壳就没意义。
async function waitForServiceReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/auth/session`;
  // 500 说明服务在监听但内部有异常。再等等；等到宽限期还不正常，
  // 就先把窗口开出来让用户看见错误页面，而不是干等 60 秒后弹一个框。
  const graceUntil = Date.now() + 20_000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      // 200 或 401 都视为 HTTP 已就绪；500 说明服务在但内部异常，继续等。
      if (res.status === 200 || res.status === 401) return;
      if (res.status >= 500 && Date.now() > graceUntil) {
        // 后端起来了但内部在报错——这种状态比「起不来」更隐蔽：
        // 页面能渲染、API 全 500，用户看到的是一堆接口报错，压根不知道出了什么事。
        // 与其开一个半残的窗口，不如明确报错并指向日志。
        const detail = `http://127.0.0.1:${port}/api/auth/session 返回 HTTP ${res.status}`;
        logStartupError("backend unhealthy", new Error(detail));
        dialog.showErrorBox(
          "后端服务异常",
          `${detail}\n\n后端已启动但内部报错，界面会无法正常工作。\n完整错误见：${path.join(resolveDataDir(), "backend.log")}`,
        );
        quitApp(1);
        return;
      }
    } catch (err) {
      // ECONNREFUSED：服务还没 bind 完，继续等。
      const code = err && (err.cause ? err.cause.code : err.code);
      if (code !== "ECONNREFUSED") {
        // 意料之外的错误直接抛出，让上层错误对话框接管。
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  dialog.showErrorBox(
    "后端服务启动超时",
    `60 秒内未收到 http://127.0.0.1:${port}/api/auth/session 的响应。\n请检查端口占用或后端日志后重试。`,
  );
  quitApp(1);
}

// ── 关闭后端 ─────────────────────────────────────────────────────────────────
// Windows 用 taskkill /F /T 杀整棵进程树（Electron + next + 其子进程都在一个组内）；
// POSIX 上向负 PID 发信号即可。
/**
 * 同步杀掉后端进程树。
 *
 * 为什么必须同步：异步 spawn 出去的 taskkill 还没跑到，主进程就退出了，
 * taskkill 变成孤儿任务，后端就还活着、端口还占着。
 * 同步版本确保「进程退出」和「端口释放」是同一时刻发生的事。
 *
 * 注意：必须传入捕获到的 child 引用，不能读模块变量——
 * cleanupBackend 会先把 backendService 置空，读模块变量会直接 return，
 * 于是后端从来没被杀过，端口一直占着。
 */
function killBackendTreeSync(child) {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    try {
      require("node:child_process").execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      /* 进程可能已经没了 */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* 忽略 */
  }
}

function cleanupBackend() {
  const child = backendService;
  backendService = null;
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  backendStopping = true;
  // 先杀进程树，再断管道。
  //
  // 顺序不能反：管道是主进程和后端之间的联系，断得太早的话，
  // 后端会收到 EPIPE 自己退出，留下一条「异常退出」的误导性日志。
  killBackendTreeSync(child);
  // 断开与子进程的管道。
  //
  // 这一步不能省：后端输出改成管道之后（stdio: "pipe"），
  // 管道上的读事件会让 Node 事件循环一直有活干，
  // 于是窗口关了、主进程却退不干净——桌面上看就是「关了还在」，
  // 后端子进程还占着端口。先 destroy 再 unref，主进程才能干净退出。
  try {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  } catch {
    /* 忽略：子进程可能已经没了 */
  }
  // 兜底：1 秒后仍存活则强杀（POSIX SIGKILL / Windows taskkill 已强杀）。
  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
      } catch {
        /* 忽略 */
      }
    }
  }, 1000).unref();
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────
// app.getPath("userData") 只在 app.ready 之后可用，所以路径解析与端口探测都放这里。
app.whenReady().then(async () => {
  try {
    // 严格顺序：WS 桥 → 后端就绪 → 自动登录并注入 Cookie → 创建窗口 → loadURL。
    // Cookie 必须在 loadURL 之前 set，否则 AuthGate 拿不到会话会被弹回 /login。
    // WS 桥必须先于 startBackend：桥绑定后把实际端口写入 GAOTAI_WS_PORT，
    // 后端子进程经 baseEnv 继承，前端才能读到「扩展连到哪个端口」。
    try {
      // 状态回调把「有几个扩展连着」落成文件，后端据此回答「插件装好了没」。
      // 只在内存里记的话，后端子进程看不到主进程的会话表。
      // 另外每 20 秒刷一次时间戳：主进程若意外挂掉，旧文件会一直停在
      // extensions>0，后端靠时间戳判断状态已经过期，不会一直骗用户说「已连接」。
      let lastState = { clients: 0, extensions: 0, tasks: 0, port: 0 };
      const writeState = () => {
        try {
          fs.writeFileSync(
            path.join(resolveDataDir(), "bridge-state.json"),
            JSON.stringify({ ...lastState, updatedAt: Date.now() }),
          );
        } catch {
          /* 状态文件写失败不该影响桥本身 */
        }
      };
      await wsBridge.startWsBridge(undefined, (state) => {
        lastState = state;
        writeState();
      });
      setInterval(writeState, 20_000).unref();
      logLifecycle(`ws bridge listening on ${wsBridge.getWsBridgePort()}`);
    } catch (err) {
      // 桥起不来只影响多平台分发，不让整个应用退出——记日志继续跑。
      logStartupError("ws bridge failed", err);
    }

    await startBackend();
    await tryAutoLogin(backendPort);
    createMainWindow();
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);
  } catch (err) {
    // 启动瞬间被外部导航打断（自动化/CDP/用户抢先点了链接）会抛 ERR_ABORTED。
    // 此时窗口已经活着，导航只是被后一次导航顶掉，不是启动失败——
    // 不能弹致命错误框，更不能把进程退掉。
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      err &&
      /ERR_ABORTED/.test(String(err))
    ) {
      logLifecycle(`startup navigation superseded: ${String(err)}`);
      return;
    }
    logStartupError("startup failed", err);
    dialog.showErrorBox("启动失败", err && err.stack ? err.stack : String(err));
    quitApp(1);
  }
});

// 窗口关闭时同步杀后端，避免残留 node 进程占用端口。
app.on("window-all-closed", () => {
  logLifecycle("window-all-closed");
  // macOS 保持 dock 常驻；其它平台直接退出。
  if (process.platform === "darwin") {
    cleanupBackend();
    return;
  }
  // 走统一出口：它用的是 app.exit(0) 而不是 app.quit()。
  //
  // app.quit() 走的是完整退出流程（before-quit → will-quit → quit），
  // 只要还有没关干净的窗口、或子进程管道没收住，它就会停在半路不退出。
  // 实测症状是：窗口关了、界面没了，主进程和后端子进程却都留在后台占着端口，
  // 桌面上看就是「关了还在」，而且没有任何报错提示。
  //
  // 桌面客户端的退出诉求很单纯——关窗即走干净，所以直接 exit。
  quitApp(0);
});

app.on("before-quit", () => {
  logLifecycle("before-quit");
  cleanupBackend();
});
app.on("will-quit", () => logLifecycle("will-quit"));
app.on("quit", () => logLifecycle("quit"));

// 进程被外部终止时（任务管理器、Ctrl+C、脚本 kill）也要回收后端进程树，
// 否则会留下占端口的 node 进程。Windows 上 SIGTERM 不会触发 before-quit，必须显式处理。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    quitApp(0);
  });
}
