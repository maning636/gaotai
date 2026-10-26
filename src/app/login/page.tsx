"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** preload 暴露的本机能力（见 electron/preload.js）。 */
type GaotaiBridge = {
  revealLocalPassword?: () => Promise<string>;
};

declare global {
  interface Window {
    gaotai?: GaotaiBridge;
  }
}

/**
 * 登录页。
 *
 * **普通用户看不到这一页。**
 *
 * 桌面客户端启动时会自动换一个会话（见 electron/main.js 的启动令牌机制），
 * 窗口打开时就已经登录好了；万一还是落到这一页（比如清了浏览器数据），
 * 页面也会自己用本机口令进去，用户什么都不用做。
 *
 * 这一页真正服务的对象是：**在浏览器里直接访问 127.0.0.1 的人**。
 * 那条路需要本机口令，因为浏览器里的网页也够得着这个端口——
 * 口令是本机的钥匙，不是账号，更不是激活码。
 */
export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  /** 是不是桌面客户端环境。 */
  const [desktop, setDesktop] = useState<boolean | null>(null);

  async function submit(value: string) {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "登录失败。");
    router.replace("/");
    router.refresh();
  }

  /**
   * 桌面客户端：自己进去。
   *
   * 正常情况下桌面端根本不会走到这一页（会话在窗口打开前就注入了）。
   * 走到这里说明会话没了（清过浏览器数据之类），那就用本机口令自动恢复——
   * 用户不该被要求做任何事。
   */
  useEffect(() => {
    const reveal = window.gaotai?.revealLocalPassword;
    if (!reveal) {
      setDesktop(false);
      return;
    }
    setDesktop(true);
    let cancelled = false;
    void (async () => {
      try {
        const value = await reveal();
        if (cancelled) return;
        if (!value) {
          setError("没找到本机口令：用户数据目录里没有 .env，或其中缺少 APP_PASSWORD。");
          return;
        }
        setBusy(true);
        await submit(value);
      } catch (issue) {
        if (cancelled) return;
        setError(issue instanceof Error ? issue.message : "自动进入失败。");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 空依赖数组是刻意的：自动登录只在挂载时做一次，不该跟着 submit 的
    // 每次重建再跑一遍（那会把用户手动登录的结果覆盖掉）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      await submit(password);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "登录失败。");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 找回口令（只在浏览器直连时有用）。
   *
   * 走 preload 桥让主进程去读本机 .env——不去新增 HTTP 接口，
   * 免得本机任意程序（甚至恶意网页）都能把口令套出去。
   */
  async function onReveal() {
    setError("");
    setHint("");
    const reveal = window.gaotai?.revealLocalPassword;
    if (!reveal) {
      setHint("当前不是桌面客户端环境，请在用户数据目录的 .env 里查看 APP_PASSWORD。");
      return;
    }
    try {
      const value = await reveal();
      if (!value) {
        setHint("没找到本机口令：用户数据目录里没有 .env，或其中缺少 APP_PASSWORD。");
        return;
      }
      setPassword(value);
      setHint("已把本机口令填进输入框，确认无误后点「进入」。");
    } catch {
      setHint("读取本机口令失败，可以从菜单「工具 → 显示本机口令」查看。");
    }
  }

  if (desktop === null) {
    return <main className="gt-login" />;
  }

  if (desktop) {
    return (
      <main className="gt-login">
        <div className="gt-panel gt-login__card gt-stack">
          <div className="gt-login__brand">
            <span className="gt-sidebar__mark" aria-hidden="true">
              台
            </span>
            <div>
              <h1 className="gt-login__title">稿台</h1>
              <p className="gt-small gt-muted" style={{ margin: 0 }}>
                本地写作工作台
              </p>
            </div>
          </div>
          <div className="gt-login__rule" />
          {error ? (
            <div className="gt-alert gt-alert--error">{error}</div>
          ) : (
            <p className="gt-body gt-muted gt-login__lead">正在进入…</p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="gt-login">
      <form onSubmit={onSubmit} className="gt-panel gt-login__card gt-stack">
        <div className="gt-login__brand">
          <span className="gt-sidebar__mark" aria-hidden="true">
            台
          </span>
          <div>
            <h1 className="gt-login__title">稿台</h1>
            <p className="gt-small gt-muted" style={{ margin: 0 }}>
              本地写作工作台
            </p>
          </div>
        </div>

        <div className="gt-login__rule" />

        <p className="gt-body gt-muted gt-login__lead">
          桌面客户端会自动进入，<strong>用客户端打开就不需要这一页</strong>。
          你现在是从浏览器直接访问本机程序，所以要这把本机钥匙——
          它不是账号，也不是激活码。
        </p>

        <label className="gt-field">
          <span className="gt-label">本机口令</span>
          <input
            className="gt-input"
            type="password"
            value={password}
            autoFocus
            onChange={event => setPassword(event.target.value)}
            placeholder="粘贴本机口令"
          />
        </label>

        {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
        {hint ? <div className="gt-alert">{hint}</div> : null}

        <button className="gt-btn gt-btn--primary gt-btn--block" type="submit" disabled={busy || !password}>
          {busy ? "正在验证…" : "进入"}
        </button>

        <button className="gt-btn gt-btn--quiet gt-btn--block" type="button" onClick={onReveal} disabled={busy}>
          忘了口令？取回本机口令
        </button>

        <p className="gt-small gt-muted gt-login__foot">
          口令存在用户数据目录的 <code className="gt-code gt-code--inline">.env</code> 里，
          字段名 <code className="gt-code gt-code--inline">APP_PASSWORD</code>。
        </p>
      </form>
    </main>
  );
}
