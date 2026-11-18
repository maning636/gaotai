// 截图编排入口（Node ESM，零新增依赖）。
//
// 职责：按「截图规范.md」用 Electron 自带 webContents.capturePage() 截一套界面图。
// 这一步只做编排——决定截哪些页、起/停开发服务器、把任务交给 shot-main.cjs、
// 最后汇总并校验 PNG 尺寸。真正的窗口、登录、截图逻辑在 shot-main.cjs。
//
// 为什么用 Electron 而不是 playwright/puppeteer：这是桌面应用，electron 本来就是
// devDependency，渲染结果与用户看到的一致（字体/阴影/缩放都不用调），零新依赖。
//
// 用法：
//   npm run shots                          # 全部预设路线
//   npm run shots -- --only=03,04          # 只截 03、04
//   npm run shots -- --base=http://127.0.0.1:3060
//   npm run shots -- --out=shots
import { spawn, execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 预设路线：序号是语义的一部分（决定官网展示顺序），不是随便编号。
// route 为 null 且带 dynamic 的项在登录后由 shot-main 动态解析（见下）。
// ---------------------------------------------------------------------------
const ROUTES = [
  { seq: "01", label: "工作台首页", route: "/" },
  { seq: "02", label: "稿件列表", route: "/projects" },
  { seq: "03", label: "概览", route: "/overview" },
  { seq: "04", label: "模板库", route: "/templates" },
  { seq: "05", label: "授权页", route: "/license" },
  { seq: "06", label: "模型配置", route: "/agent-config" },
  { seq: "07", label: "公众号接入", route: "/wechat" },
  { seq: "08", label: "安全", route: "/security" },
  // 正文编辑器需要具体稿件 id，不能写死；库里没有稿件就跳过（shot-main 判定），
  // 并在汇总里说明「08 之后需要真实稿件，跳过」。不为了截图去造真实数据。
  { seq: "09", label: "正文编辑器", route: null, dynamic: "first-project" },
];

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : fallback;
}

const BASE = argValue("base", "http://127.0.0.1:3060");
const OUT_DIR = path.resolve(ROOT, argValue("out", "shots"));
const ONLY_RAW = argValue("only", "");

// --only=03,04 → ['03','04']；未给则截全部。
const ONLY = ONLY_RAW
  ? ONLY_RAW.split(",").map((s) => s.trim().padStart(2, "0")).filter(Boolean)
  : null;

const { hostname: BASE_HOST, port: BASE_PORT } = new URL(BASE);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 端口是否已监听（TCP 层）。 */
function portOpen(port, host = "127.0.0.1", timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 等端口真正可用（TCP 可连，且 HTTP 层能给出响应，避免只连上还在编译）。 */
async function waitForServer(port, host, totalMs) {
  const started = Date.now();
  while (Date.now() - started < totalMs) {
    if (await portOpen(port, host)) {
      // 端口已监听；再确认 HTTP 能应答（next dev 首次请求会触发编译，任何状态码都算活）。
      try {
        const res = await fetch(`http://${host}:${port}/login`, { signal: AbortSignal.timeout(3000) });
        if (res.status) return true;
      } catch {
        // 连接被拒/超时：还没完全起来，继续等。
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 从环境变量或项目根 .env 读登录口令。.env 由服务启动时的运行时引导生成。 */
function readPassword() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD;
  const envFile = path.join(ROOT, ".env");
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(/^\s*(?:export\s+)?APP_PASSWORD\s*=\s*(.+?)\s*$/m);
    if (match) return match[1].trim();
  }
  return "";
}

/** 杀 dev 服务器进程树（Windows 上 npm run dev 会再拉 node 子进程，必须整树杀）。 */
function killServer(child) {
  // 必须同步：脚本下一秒就 process.exit()，异步 spawn 的 taskkill 根本来不及执行，
  // 结果 dev 服务器变成孤儿进程继续占着 3060，还会把父进程的 stdout 管道挂住，
  // 表现为「截图都出来了，但命令一直不返回」。
  const pid = findListenerPid(BASE_PORT);
  if (pid) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
    } catch {
      /* 继续下面的按 child.pid 杀 */
    }
  }
  if (child && !child.killed && child.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
    } catch {
      child.kill();
    }
  }
}

/** 找出监听指定端口的进程 PID（netstat 输出解析，避免依赖进程名/命令行）。 */
function findListenerPid(port) {
  try {
    const out = execSync(`netstat -ano`, { encoding: "utf8" });
    const re = new RegExp(`:${port}\\s+.*LISTENING\\s+(\\d+)\\s*$`, "m");
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** 读 PNG 头部的像素尺寸（IHDR 宽高，8 字节签名后偏移 16/20）。 */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** 跑 Electron 截图器，解析其末尾打印的 __SHOTS_RESULT__ JSON。 */
function runElectron(jobs, password) {
  return new Promise((resolve) => {
    // 用 electron 二进制直连（run-desktop.mjs 的惯例），不经过 npx：
    // npx 在 Windows + shell:true 下会解析成 .cmd，spawn 起不来，导致整批挂起。
    // electron 是 devDependency，node_modules/electron/dist/electron.exe 必然存在。
    const electronBin = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    if (!existsSync(electronBin)) {
      resolve({ code: -1, result: { ok: false, error: `找不到 electron 二进制：${electronBin}`, results: [] } });
      return;
    }
    const child = spawn(electronBin, [path.join(ROOT, "scripts", "shot-main.cjs")], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SHOT_BASE: BASE,
        SHOT_OUT: OUT_DIR,
        SHOT_JOBS: JSON.stringify(jobs),
        APP_PASSWORD: password,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      err += d;
      process.stderr.write(d);
    });
    child.on("close", (code) => {
      const match = out.match(/__SHOTS_RESULT__ (\{.*\})/s);
      const result = match
        ? JSON.parse(match[1])
        : { ok: false, error: `Electron 未输出结果（exit ${code}）${err ? "：" + err.slice(-300) : ""}`, results: [] };
      resolve({ code, result });
    });
    child.on("error", (e) => {
      resolve({ code: -1, result: { ok: false, error: `启动 Electron 失败：${e.message}`, results: [] } });
    });
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const jobs = ROUTES.filter((r) => !ONLY || ONLY.includes(r.seq));
  if (jobs.length === 0) {
    console.error(`[shots] --only=${ONLY_RAW} 没有匹配任何预设路线。`);
    process.exit(1);
  }

  // 1. 若服务没在跑，起 dev（注入授权旁路：开发态未激活时 guard() 会锁 API）。
  let server = null;
  let alreadyRunning = await portOpen(BASE_PORT, BASE_HOST);
  if (!alreadyRunning) {
    console.log(`[shots] 未检测到 ${BASE}，启动开发服务器…`);
    server = spawn("npm", ["run", "dev"], {
      cwd: ROOT,
      shell: true,
      stdio: "inherit",
      env: { ...process.env, GAOTAI_LICENSE_BYPASS: "1" },
    });
    const up = await waitForServer(BASE_PORT, BASE_HOST, 120_000);
    if (!up) {
      killServer(server);
      console.error(`[shots] 开发服务器未能在 120s 内就绪（${BASE}）。`);
      process.exit(1);
    }
    console.log(`[shots] 开发服务器已就绪：${BASE}`);
  } else {
    console.log(`[shots] 检测到 ${BASE} 已在运行，直接复用。`);
  }

  // 2. 登录口令：环境变量优先，否则从 .env 读（服务启动时自动生成）。
  const password = readPassword();
  if (!password) {
    if (server) killServer(server);
    console.error("[shots] 未找到登录口令：请设置环境变量 APP_PASSWORD，或确认项目根 .env 里有 APP_PASSWORD。");
    process.exit(1);
  }

  // 3. 交给 Electron 截图。
  console.log(`[shots] 开始截图 ${jobs.length} 页 → ${OUT_DIR}`);
  const { result } = await runElectron(jobs, password);

  // 4. 若服务是脚本起的，关掉它（脚本结束即恢复原状，不留后台进程）。
  if (server) killServer(server);

  // 5. 汇总 + 尺寸校验。
  const rows = result.results ?? [];
  const failed = rows.filter((r) => !r.ok);
  console.log("\n[shots] 汇总：");
  let allSizeOk = true;
  let anyOver2MB = false;
  for (const r of rows) {
    if (!r.ok) {
      console.log(`  ${r.seq} ${r.label.padEnd(6)} ✗ ${r.skipped ? "跳过（" + (r.error ?? "") + "）" : r.error}`);
      continue;
    }
    const size = pngSize(r.file);
    const dimsOk = size && size.w === 2880 && size.h === 1800;
    if (!dimsOk) allSizeOk = false;
    if (r.size > 2 * 1024 * 1024) anyOver2MB = true;
    const mb = (r.size / 1024 / 1024).toFixed(2);
    console.log(
      `  ${r.seq} ${r.label.padEnd(6)} ✓ ${size ? `${size.w}×${size.h}` : "尺寸读取失败"}${dimsOk ? "" : "（非 2880×1800!）"}  ${mb}MB`,
    );
  }

  // 6. 脱敏自检：PNG 是压缩二进制，grep 只能粗查，必须人工确认（规范 §四）。
  //    这里如实报告扫描结果，不做不可靠的 OCR，也不伪造结论。
  const grepHits = await grepSensitive(OUT_DIR);
  console.log("\n[shots] 脱敏自检（仅粗查，PNG 为压缩二进制，无法可靠 OCR）：");
  if (grepHits.length === 0) {
    console.log("  grep 未匹配到明显密钥/邮箱样式字符串。");
  } else {
    console.log(`  grep 命中 ${grepHits.length} 处，请人工复核：`);
    for (const h of grepHits.slice(0, 10)) console.log(`    ${h}`);
  }
  console.log("  请人工确认截图里没有真实邮箱/密钥；本项目的演示数据在 data/ 目录，正式出图前建议用干净的演示库。");

  if (rows.length === 0) {
    console.error(`[shots] 没有产出任何截图。`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.warn(`\n[shots] ${failed.length} 页失败（含跳过）。`);
  }
  if (!allSizeOk) {
    console.warn("[shots] 存在尺寸不是 2880×1800 的产物，请检查。");
  }
  if (anyOver2MB) {
    console.warn("[shots] 存在单张超过 2MB 的产物：可能有动画未停，请人工确认。");
  }
  // 汇总说明「08 之后需要真实稿件，跳过」。
  const editorJob = rows.find((r) => r.seq === "09");
  if (editorJob && !editorJob.ok && editorJob.skipped) {
    console.log("\n[shots] 提示：正文编辑器需要真实稿件 id（库里当前没有稿件），已跳过；不为此造数据。");
  }

  const ok = failed.length === 0 && allSizeOk;
  console.log(`\n[shots] 完成：${rows.filter((r) => r.ok).length}/${rows.length} 成功。`);
  process.exit(ok ? 0 : 1);
}

/** 用 grep 粗扫 shots 目录里的敏感字符串（PNG 二进制，命中仅供参考）。 */
function grepSensitive(dir) {
  return new Promise((resolve) => {
    const hits = [];
    // 截图可能一张都没成功（目录不存在/为空），此时不是敏感问题，如实返回空。
    if (!existsSync(dir)) return resolve(hits);
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png"));
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const b = readFileSync(full);
        const s = b.toString("latin1");
        if (/sk-[a-z0-9]{16,}/i.test(s)) hits.push(`${f}: sk-...`);
        if (/@(qq|163|gmail)\.com/i.test(s)) hits.push(`${f}: @*邮箱*`);
      } catch {
        /* 读不到就跳过 */
      }
    }
    resolve(hits);
  });
}

main().catch((e) => {
  console.error("[shots] 未捕获异常：", e);
  process.exit(1);
});
