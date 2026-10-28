import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomInt } from 'node:crypto';
import { parseConfig, selfCheck } from './lib/config.mjs';
import { createStore } from './lib/store.mjs';
import { createAssets } from './lib/assets.mjs';
import { createRateLimiter, createRedeemLimiter, failByCode } from './lib/http.mjs';
import { derivePublicKeyPem } from './lib/token.mjs';
import { handle as activate } from './routes/activate.mjs';
import { handle as refresh } from './routes/refresh.mjs';
import { handle as status } from './routes/status.mjs';
import { handle as assetsRoute } from './routes/assets.mjs';
import { handle as redeemRoute } from './routes/redeem.mjs';
import { privacyPageHtml } from './lib/privacy-page.mjs';

// createApp 是测试入口：注入临时目录、临时密钥、独立 store/limiter
// 返回 { handler, close }
// server.mjs 的正式入口只做 读环境变量 → createApp → listen
export function createApp({ config: cfg }) {
  let config = cfg;

  // 启动自检：私钥缺失/不可读、data 不可写 → 暴露中文错误
  const check = selfCheck(config);
  if (!check.ok) {
    // 抛出由调用方决定 exit(1) 还是测试失败
    const err = new Error('启动自检失败：\n' + check.errors.join('\n'));
    err.selfCheckErrors = check.errors;
    throw err;
  }

  // 公钥从私钥派生，供资产接口验签用
  if (!config.publicKey) {
    config.publicKey = derivePublicKeyPem(config.privateKey);
  }

  const now = () => Date.now();
  const store = createStore({ dataDir: config.dataDir, now, codeFormat: config.codeFormat });
  const assets = createAssets({ assetsDir: config.assetsDir });

  // 限流器可被测试替换为独立实例
  const rateLimiter = config.rateLimiter || createRateLimiter({
    maxFails: config.rateFails,
    windowMs: config.rateWindowMs,
    now,
  });
  const redeemLimiter = config.redeemLimiter || createRedeemLimiter({
    perHour: config.redeemPerHour,
    now,
  });

  const ctx = {
    store,
    assets,
    config,
    rateLimiter,
    redeemLimiter,
    now,
    randomInt: config.randomInt || randomInt,
  };

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      failByCode(res, 'bad_request', 'URL 解析失败');
      return;
    }
    const pathname = url.pathname;
    const method = req.method;

    try {
      // 路由表：按 method + pathname 前缀匹配
      if (method === 'POST' && pathname === '/v1/activate') {
        await activate(ctx, req, res);
      } else if (method === 'POST' && pathname === '/v1/refresh') {
        await refresh(ctx, req, res);
      } else if (method === 'POST' && pathname === '/v1/status') {
        await status(ctx, req, res);
      } else if (method === 'GET' && (pathname === '/v1/assets/manifest' || /^\/v1\/assets\/[^/]+$/.test(pathname))) {
        await assetsRoute(ctx, req, res, url);
      } else if (method === 'POST' && pathname === '/v1/redeem') {
        await redeemRoute(ctx, req, res, url);
      } else if (method === 'GET' && pathname === '/redeem') {
        await redeemRoute(ctx, req, res, url);
      } else if (method === 'GET' && pathname === '/privacy') {
        const html = privacyPageHtml();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(html));
        res.end(html);
      } else {
        failByCode(res, 'not_found', '接口不存在');
      }
    } catch {
      // 未预期的异常兜底，避免连接悬挂
      if (!res.headersSent) {
        failByCode(res, 'internal', '服务内部错误');
      }
      // 内部错误也写一条审计
      try {
        store.appendAudit({ ip: '', codePrefix: '', errorCode: 'internal', event: 'unhandled' });
      } catch (auditErr) {
        // 审计写入是 best-effort：磁盘或权限问题不应让请求处理再次抛错
        console.warn('内部错误审计写入失败：', auditErr.message);
      }
    }
  }

  function close() {
    // store 是同步写盘，没有需要 flush 的缓冲；预留 hook 供未来扩展
    rateLimiter.reset();
    redeemLimiter.reset();
  }

  return { handler, close, ctx };
}

// ---- 正式启动入口 ----
// 用 pathToFileURL 而不是拼 `file://${argv[1]}`：Windows 的 argv[1] 是反斜杠路径、
// 还带中文目录，拼出来的 URL 与 import.meta.url 永远不相等，进程会静默退出。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = parseConfig(process.env);
  let app;
  try {
    app = createApp({ config });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const server = createServer((req, res) => {
    app.handler(req, res).catch(() => {
      if (!res.headersSent) {
        failByCode(res, 'internal', '服务内部错误');
      }
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`授权服务器已启动：http://${config.host}:${config.port}`);
    console.log(`数据目录：${config.dataDir}`);
    console.log(`资产目录：${config.assetsDir}`);
  });

  // 优雅退出：关闭 server、清理限流器
  function shutdown(sig) {
    console.log(`\n收到 ${sig}，正在关闭…`);
    server.close(() => {
      app.close();
      console.log('已关闭');
      process.exit(0);
    });
    // 兜底：5 秒后强制退出，避免卡死
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
