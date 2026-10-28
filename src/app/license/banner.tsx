"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { LicenseSnapshot } from "../../lib/license/types";

/**
 * 全局授权横幅。
 *
 * 挂在 AppShell 的 gt-main 顶部、header 之前。`status` 为 `missing`/`expired` 时
 * 渲染一条黄色横幅（硬边框风格），`activated`/`bypass` 时不渲染，请求失败也静默——
 * 授权接口挂了不能把整页搞坏。
 *
 * `/license` 页自身不显示（那页已经有完整的状态卡，再挂一条横幅重复且挡视线）。
 */
export function LicenseBanner() {
  const pathname = usePathname();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (pathname === "/license") {
      setShow(false);
      return;
    }
    let alive = true;
    fetch("/api/license/status", { cache: "no-store" })
      .then(resp => (resp.ok ? resp.json() : Promise.reject(new Error("status_failed"))))
      .then((body: { license?: LicenseSnapshot }) => {
        if (!alive) return;
        const status = body.license?.status;
        setShow(status === "missing" || status === "expired");
      })
      .catch(() => {
        // 授权接口挂了：静默，不渲染横幅，不破坏页面。
        if (alive) setShow(false);
      });
    return () => {
      alive = false;
    };
  }, [pathname]);

  if (!show) return null;

  return (
    <div className="gt-license-banner" role="status">
      <p className="gt-license-banner__text">还没激活，技能包、专题模板、图解和公众号推送都用不了。</p>
      <Link href="/license" className="gt-license-banner__link">
        去激活
      </Link>
    </div>
  );
}
