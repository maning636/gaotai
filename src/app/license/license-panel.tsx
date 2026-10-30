"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LicenseSnapshot } from "../../lib/license/types";

/**
 * 授权页客户端面板。
 *
 * 状态全部来自 `/api/license/status` 的服务端快照，前端不自己拼——
 * 激活/重新验证成功后重新拉一次，避免本地状态与服务端不一致。
 *
 * 注册码输入：`GT-` 前缀引导，自动大写、去掉非法字符、每 4 位插 `-`。
 * 只做展示层格式化，提交前把 `-` 全去掉再发（服务端按协议要求）。
 */

/** 功能 feature 键 → 中文条目。 */
const FEATURE_LABELS: { key: string; label: string; note: string }[] = [
  { key: "core", label: "基础写作", note: "写作、稿件、编辑器等核心功能" },
  { key: "skills", label: "技能包", note: "写作技法与工序增强" },
  { key: "prompts", label: "提示词", note: "AI 生成用的提示词模板" },
  { key: "topics", label: "专题模板", note: "专题策划与选题模板" },
  { key: "layout-packs", label: "排版包", note: "公众号图文排版模板" },
  { key: "illustration", label: "图解", note: "配图与图解生成" },
];

/** 注册码分组：`GT-7F3K-9QW2-M4XB-8HZP`，字母数字共 16 位。 */
const CODE_LENGTH = 16;

/** 去掉 `-` 与空白，只留大写字母与数字。 */
function normalizeCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * 拆出注册码 body：固定前缀 `GT` 之后的 16 位字母数字。
 *
 * 用户可能粘贴完整码（含 GT）、只输 GT、或只输后 16 位。以 GT 开头就当
 * 前缀剥掉，否则整串视为 body——输入框始终显示 `GT-` 前缀引导。
 */
function extractBody(letters: string): string {
  const rest = letters.startsWith("GT") ? letters.slice(2) : letters;
  return rest.slice(0, CODE_LENGTH);
}

/** 格式化为 `GT-XXXX-XXXX-XXXX-XXXX`。 */
function formatCode(letters: string): string {
  const body = extractBody(letters);
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += 4) {
    chunks.push(body.slice(i, i + 4));
  }
  return "GT-" + chunks.join("-");
}

/** 已激活的剩余比例（0–1），用于进度条。有效期固定 30 天，按协议 §3。 */
function remainingRatio(expiresAt: number): number {
  const total = 30 * 24 * 60 * 60 * 1000;
  const remaining = expiresAt - Date.now();
  const ratio = remaining / total;
  return Math.min(1, Math.max(0, ratio));
}

/** 到期日 YYYY-MM-DD（本地时区）。 */
function formatDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 状态徽章文案与样式（红/绿/黄/灰，对应 gt-license__badge--*）。 */
function badgeFor(status: LicenseSnapshot["status"]): { text: string; cls: string } {
  switch (status) {
    case "activated":
      return { text: "已激活", cls: "gt-license__badge--green" };
    case "expired":
      return { text: "已过期", cls: "gt-license__badge--yellow" };
    case "bypass":
      return { text: "开发模式", cls: "gt-license__badge--gray" };
    default:
      return { text: "未激活", cls: "gt-license__badge--red" };
  }
}

export function LicensePanel() {
  const [license, setLicense] = useState<LicenseSnapshot | null>(null);
  const [machine, setMachine] = useState("");
  const [assets, setAssets] = useState<{ version: string; ready: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState("");

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitOk, setSubmitOk] = useState("");

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");

  const [copied, setCopied] = useState(false);
  const machineRef = useRef<HTMLDivElement>(null);

  /** 拉一次状态快照。 */
  const load = useCallback(async () => {
    try {
      const resp = await fetch("/api/license/status", { cache: "no-store" });
      const body = (await resp.json().catch(() => ({}))) as {
        license?: LicenseSnapshot;
        machine?: string;
        assets?: { version: string; ready: boolean } | null;
      };
      if (!resp.ok) {
        throw new Error(body.license ? "读取授权状态失败。" : (body as { error?: string }).error ?? "读取授权状态失败。");
      }
      setLicense(body.license ?? null);
      setMachine(body.machine ?? "");
      setAssets(body.assets ?? null);
      setStatusError("");
    } catch (issue) {
      setStatusError(issue instanceof Error ? issue.message : "读取授权状态失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 激活。 */
  async function onActivate(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const letters = normalizeCode(code);
    const body = extractBody(letters);
    if (body.length !== CODE_LENGTH) {
      setSubmitError("注册码格式不对：应为 GT- 开头 + 16 位字母数字，例如 GT-7F3K-9QW2-M4XB-8HZP。");
      return;
    }
    // 提交完整码（含 GT- 前缀与分隔连字符），与服务端协议一致。
    const fullCode = formatCode(letters);
    setSubmitting(true);
    setSubmitError("");
    setSubmitOk("");
    try {
      const resp = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: fullCode }),
      });
      const body = (await resp.json().catch(() => ({}))) as {
        message?: string;
        license?: LicenseSnapshot;
        machine?: string;
      };
      if (!resp.ok) {
        // 只显示服务端中文 message，不暴露英文错误码。
        setSubmitError(body.message ?? "激活失败，请稍后再试。");
        return;
      }
      setSubmitOk(`激活成功，有效期至 ${body.license?.expiresAt ? formatDate(body.license.expiresAt) : "—"}。`);
      setCode("");
      await load();
    } catch {
      setSubmitError("激活失败，请检查网络后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  /** 重新验证（refresh）。 */
  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError("");
    setSubmitOk("");
    try {
      const resp = await fetch("/api/license/refresh", { method: "POST" });
      const body = (await resp.json().catch(() => ({}))) as {
        message?: string;
        license?: LicenseSnapshot;
      };
      if (!resp.ok) {
        setRefreshError(body.message ?? "重新验证失败，请稍后再试。");
        return;
      }
      await load();
    } catch {
      setRefreshError("重新验证失败，请检查网络后重试。");
    } finally {
      setRefreshing(false);
    }
  }

  /** 手动同步资源包（激活后从授权服务器加密下发四类资产）。 */
  async function onSyncAssets() {
    if (syncing) return;
    setSyncing(true);
    setSyncError("");
    try {
      const resp = await fetch("/api/license/sync", { method: "POST" });
      const body = (await resp.json().catch(() => ({}))) as {
        assets?: { status: string; version?: string; error?: string };
        message?: string;
      };
      if (!resp.ok) {
        setSyncError(body.message ?? "同步失败，请稍后再试。");
        return;
      }
      await load();
    } catch {
      setSyncError("同步失败，请检查网络后重试。");
    } finally {
      setSyncing(false);
    }
  }

  /** 复制机器码。失败时选中文本提示手动复制。 */
  async function onCopyMachine() {
    if (!machine) return;
    try {
      await navigator.clipboard.writeText(machine);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const node = machineRef.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }

  const activated = license?.status === "activated";
  const status = license?.status ?? "missing";
  const badge = badgeFor(status);
  const serverConfigured = license?.serverConfigured ?? true;
  const featureSet = new Set(license?.features ?? []);

  return (
    <div className="gt-license">
      {/* 未配置授权服务器：整页顶部黄条，激活按钮禁用。 */}
      {!serverConfigured ? (
        <div className="gt-alert gt-alert--warn" role="alert">
          没有配置授权服务器，激活不可用。请在 <code className="gt-code--inline">.env</code> 里设置
          <code className="gt-code--inline">GAOTAI_LICENSE_SERVER</code> 后重启。
        </div>
      ) : null}

      <div className="gt-license__grid">
        {/* 左栏 */}
        <div className="gt-license__col gt-stack gt-stack--lg">
          {/* 1. 当前状态 */}
          <section className="gt-panel gt-panel--flat">
            <div className="gt-panel__head">
              <h2 className="gt-panel__title">当前状态</h2>
              <span className={`gt-license__badge ${badge.cls}`}>{badge.text}</span>
            </div>

            {loading ? (
              <p className="gt-small gt-muted">读取授权状态…</p>
            ) : statusError ? (
              <p className="gt-error" role="alert">
                {statusError}
              </p>
            ) : license ? (
              <div className="gt-stack gt-stack--sm">
                <div className="gt-license__kv">
                  <span className="gt-small gt-muted">注册码</span>
                  <span className="gt-mono">{license.code ?? "—"}</span>
                </div>
                <div className="gt-license__kv">
                  <span className="gt-small gt-muted">到期日</span>
                  <span className="gt-mono">
                    {license.expiresAt ? `${formatDate(license.expiresAt)}（剩余 ${license.daysLeft ?? 0} 天）` : "—"}
                  </span>
                </div>

                {/* 已激活：剩余比例细进度条 */}
                {activated && license.expiresAt ? (
                  <div className="gt-license__bar" aria-hidden="true">
                    <div
                      className="gt-license__bar-fill"
                      style={{ width: `${Math.round(remainingRatio(license.expiresAt) * 100)}%` }}
                    />
                  </div>
                ) : null}

                <div className="gt-license__kv">
                  <span className="gt-small gt-muted">机器码</span>
                  <span className="gt-license__machine">
                    <span ref={machineRef} className="gt-mono">
                      {machine || "—"}
                    </span>
                    <button className="gt-btn gt-btn--sm gt-btn--quiet" type="button" onClick={onCopyMachine}>
                      {copied ? "已复制" : "复制"}
                    </button>
                  </span>
                </div>
              </div>
            ) : null}
          </section>

          {/* 2. 激活卡 */}
          <section className="gt-panel gt-panel--flat">
            <div className="gt-panel__head">
              <h2 className="gt-panel__title">激活</h2>
            </div>

            {activated ? (
              <div className="gt-stack gt-stack--sm">
                <p className="gt-small gt-muted" style={{ margin: 0 }}>
                  已激活，无需重复操作。到期前 7 天会自动续期；换网络或服务器恢复后，可手动重新验证。
                </p>
                <div className="gt-row">
                  <button
                    className="gt-btn"
                    type="button"
                    onClick={onRefresh}
                    disabled={refreshing || !serverConfigured}
                  >
                    {refreshing ? "验证中…" : "重新验证"}
                  </button>
                </div>
                {refreshError ? (
                  <p className="gt-error" role="alert" aria-live="polite">
                    {refreshError}
                  </p>
                ) : null}
                {/* 资源包：激活后从授权服务器加密下发。
                    已就绪时也保留一个「检查更新」——提示词改了、技能包加了东西，
                    用户得有个手动入口能立刻拿到，而不是只能等下次启动。 */}
                <div className="gt-license__kv">
                  <span className="gt-small gt-muted">资源包</span>
                  <span className="gt-row">
                    <span className={assets?.ready ? "gt-small" : "gt-small gt-muted"}>
                      {assets?.ready ? `v${assets.version} 已就绪` : "未就绪"}
                    </span>
                    <button
                      className="gt-btn gt-btn--sm gt-btn--quiet"
                      type="button"
                      onClick={onSyncAssets}
                      disabled={syncing || !serverConfigured}
                    >
                      {syncing ? "同步中…" : assets?.ready ? "检查更新" : "同步"}
                    </button>
                  </span>
                </div>
                {syncError ? (
                  <p className="gt-error" role="alert" aria-live="polite">
                    {syncError}
                  </p>
                ) : null}
              </div>
            ) : (
              <form className="gt-stack gt-stack--sm" onSubmit={onActivate}>
                <label className="gt-field">
                  <span className="gt-label">注册码</span>
                  <input
                    className="gt-input gt-mono"
                    type="text"
                    value={code}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="GT-7F3K-9QW2-M4XB-8HZP"
                    disabled={submitting || !serverConfigured}
                    onChange={event => setCode(formatCode(normalizeCode(event.target.value)))}
                    aria-describedby="license-activate-hint"
                  />
                </label>
                <p className="gt-hint" id="license-activate-hint" style={{ margin: 0 }}>
                  在「设置 → 授权」之外，也可以关注作者服务号领取注册码。
                </p>
                {submitError ? (
                  <p className="gt-error" role="alert" aria-live="polite">
                    {submitError}
                  </p>
                ) : null}
                {submitOk ? (
                  <p className="gt-small gt-license__ok" role="status" aria-live="polite">
                    {submitOk}
                  </p>
                ) : null}
                <button
                  className="gt-btn gt-btn--primary"
                  type="submit"
                  disabled={submitting || !serverConfigured}
                >
                  {submitting ? "激活中…" : "激活"}
                </button>
              </form>
            )}
          </section>
        </div>

        {/* 右栏 */}
        <div className="gt-license__col gt-stack gt-stack--lg">
          {/* 4. 注册码从哪来 */}
          <section className="gt-panel gt-panel--flat">
            <div className="gt-panel__head">
              <h2 className="gt-panel__title">注册码从哪来</h2>
            </div>
            <ol className="gt-list">
              <li className="gt-list__item">关注公众号「马哥AI落地」；</li>
              <li className="gt-list__item">直接发两个字：稿台（或在菜单里点「领注册码」）；</li>
              <li className="gt-list__item">公众号会回你一个注册码，复制过来填在下面。</li>
            </ol>
            <p className="gt-small gt-muted" style={{ marginBottom: 0 }}>
              授权服务器：{serverConfigured ? "已配置" : "未配置"}。
            </p>
          </section>

          {/* 5. 授权包含什么 */}
          <section className="gt-panel gt-panel--flat">
            <div className="gt-panel__head">
              <h2 className="gt-panel__title">授权包含什么</h2>
            </div>
            <ul className="gt-list" style={{ marginBottom: 0 }}>
              {FEATURE_LABELS.map(item => {
                const enabled = activated && featureSet.has(item.key);
                return (
                  <li className="gt-list__item gt-license__feature" key={item.key}>
                    <span className={enabled ? "" : "gt-muted"}>
                      <strong>{item.label}</strong> · {item.note}
                    </span>
                    {enabled ? null : <span className="gt-tag gt-tag--yellow gt-license__feature-tag">需激活</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
