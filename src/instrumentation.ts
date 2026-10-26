/**
 * 运行时引导。
 *
 * Next 的 instrumentation 钩子在服务启动时执行一次，正好是「桌面客户端第一次运行」
 * 这个时刻。桌面版没有可编辑的 .env：登录口令与会话密钥必须由程序生成，
 * 而且必须赶在 Electron 尝试自动登录之前就绪。
 *
 * 这里的失败不阻断启动——登录接口还会再兜底一次，用户也能手动再触发。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { ensureRuntimeEnv } = await import("./lib/bootstrap");
    const result = await ensureRuntimeEnv();
    console.log("[gaotai] 运行时配置就绪：", {
      created: result.created,
      envPath: result.envPath,
      dataDir: process.env.GAOTAI_DATA_DIR ?? "(未覆盖，使用工作目录)",
    });
  } catch (error) {
    console.error("[gaotai] 运行时配置准备失败：", error);
  }
}
