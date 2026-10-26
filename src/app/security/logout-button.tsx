"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * 退出登录。
 *
 * 只在**浏览器直连**时才有意义：桌面客户端每次启动都会自动换一个会话，
 * 点「退出登录」的结果只是回到登录页、然后又自动进去——
 * 那不叫退出，叫刷新。所以桌面端这一项改成一句话说明。
 */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [desktop, setDesktop] = useState<boolean | null>(null);

  useEffect(() => {
    setDesktop(Boolean(window.gaotai?.revealLocalPassword));
  }, []);

  async function onLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (desktop === null) return null;

  if (desktop) {
    return (
      <span className="gt-small gt-muted">
        桌面客户端每次启动都会自动进入，不需要退出登录。要锁住这台机器，关掉程序就行。
      </span>
    );
  }

  return (
    <button className="gt-btn gt-btn--danger" type="button" onClick={onLogout} disabled={busy}>
      {busy ? "退出中…" : "退出登录"}
    </button>
  );
}
