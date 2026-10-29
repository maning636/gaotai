"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppPolicy } from "@/lib/app-update";

/**
 * 全屏版本更新覆盖层。
 *
 * 挂在 `layout.tsx` 的 `<body>` 内、`{children}` 之外，保证任何页面（含登录页）
 * 都会被它盖住。挂载时问一次 `/api/app/update`：
 * - `policy === null` 或 `policy.blocked === false` → 不渲染任何东西（照常使用）；
 * - `policy.blocked === true` → 渲染全屏锁层，用户只能去下载更新或重新检查。
 *
 * 设计原则：**任何异常都不阻塞**。fetch 失败、JSON 解析失败、渲染抛错，
 * 都只能让这层不出现在屏幕上，绝不能让应用因为更新检查而打不开。
 * 更新检查是「锦上添花」的提醒，不是应用可用性的前提。
 */

type UpdateResponse = {
  policy: AppPolicy | null;
  currentVersion: string;
};

export function UpdateGate() {
  const [policy, setPolicy] = useState<AppPolicy | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [checked, setChecked] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckNotice, setRecheckNotice] = useState<string | null>(null);

  const fetchPolicy = useCallback(async (force: boolean) => {
    setRecheckNotice(null);
    try {
      const res = await fetch(`/api/app/update${force ? "?force=1" : ""}`);
      if (!res.ok) return; // 接口 4xx/5xx：不拦，静默当作没有更新策略。
      const data = (await res.json()) as UpdateResponse;
      setPolicy(data.policy ?? null);
      setCurrentVersion(data.currentVersion ?? "");
    } catch {
      // fetch 抛错（网络/JSON 解析）：不拦。页面照常打开。
      setPolicy(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 挂载时检查一次。任何异常都被 fetchPolicy 吞掉，不会影响首屏。
    void fetchPolicy(false).finally(() => {
      if (!cancelled) setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPolicy]);

  // 未检查完成 / 无策略 / 不要求更新：什么都不渲染。
  if (!checked || policy === null || policy.blocked !== true) return null;

  const downloadLabel = policy.mode === "direct" ? "立即下载" : "去下载新版本";

  const openDownload = () => {
    if (!policy.url) return;
    try {
      // mode === "direct" 的「立即下载」目前也只做打开链接：下载器以后补。
      // TODO: mode === "direct" 时接入直接下载（如 stream 落盘 + 进度提示），
      //       本版先统一走 window.open，让用户至少能拿到安装包。
      window.open(policy.url, "_blank", "noopener,noreferrer");
    } catch {
      // 打开失败不影响页面（用户可手动复制 URL 或再点一次）。
    }
  };

  const recheck = async () => {
    setRechecking(true);
    await fetchPolicy(true);
    setRechecking(false);
    setRecheckNotice("还是旧版本，请确认安装完成后再试");
  };

  return (
    <div className="gt-update-overlay" role="dialog" aria-modal="true" aria-labelledby="gt-update-title">
      <div className="gt-update-card">
        <span className="gt-update-card__tag">版本更新</span>
        <h1 id="gt-update-title" className="gt-update-card__title">
          需要更新到 v{policy.latest} 才能继续使用
        </h1>

        {policy.notes ? <p className="gt-update-card__notes">{policy.notes}</p> : null}

        <div className="gt-update-card__steps">
          <p>
            <strong>1.</strong> 点击下方按钮下载新版本安装包（当前 v{currentVersion || "?"} → 最新 v{policy.latest}）。
          </p>
          <p>
            <strong>2.</strong> 下载后双击安装、<strong>覆盖安装</strong>即可——注册码不用重新领，你的稿子都在。
          </p>
          <p>
            <strong>3.</strong> 若安装时 Windows 提示「已保护你的电脑」，点「<strong>更多信息</strong> → 仍要运行」。
          </p>
        </div>

        <div className="gt-update-card__actions">
          <button type="button" className="gt-btn gt-btn--primary gt-btn--lg" onClick={openDownload}>
            {downloadLabel}
          </button>
          <button type="button" className="gt-btn" onClick={recheck} disabled={rechecking}>
            {rechecking ? "正在检查…" : "我已更新，重新检查"}
          </button>
        </div>

        {recheckNotice ? <p className="gt-update-card__notice">{recheckNotice}</p> : null}

        <p className="gt-update-card__foot">
          当前版本 v{currentVersion || "?"}，最新 v{policy.latest}
        </p>
      </div>
    </div>
  );
}
