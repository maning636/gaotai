"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import Link from "next/link";
import styles from "./multi-platform.module.css";
import {
  getAllPlatforms,
  type PlatformCategory,
  type PlatformMeta,
  type SyncMode,
} from "../../../lib/bridge/platform-registry";

/**
 * 多平台分发面板（客户端组件）。
 *
 * 平台墙由平台注册表驱动（getAllPlatforms()，31 个），外加稿台自有平台
 * feishu——注册表未收录，但现有链路（content-script、electron/ws-bridge、
 * protocol.ts 的 PLATFORMS）都依赖它，保留以保持向后兼容。
 *
 * 流程：搜索/分类/组合选平台 → 选稿件 → 点「同步到选中平台」→ 对每个平台
 * POST /api/bridge/sync 拿 taskId → 轮询 /api/bridge/task 直到 done/failed。
 * 批量按平台逐个串行同步，结果按平台展示。
 *
 * 连接状态通过轮询 GET /api/bridge/status 获取（WS 桥由 Electron 主进程起，
 * 后端子进程以客户端身份连上）。扩展未连上时显示「请安装浏览器扩展」。
 */

type Project = { id: string; title: string; stage: string };

type BridgeStatus = { running: boolean; port: number; clients: number; extensions?: number };

type BridgeTaskStatus = "pending" | "delivered" | "done" | "failed";

type SyncOutcome = {
  status: BridgeTaskStatus;
  result?: { ok?: boolean; url?: string; reason?: string };
};

/** 各平台同步结果表（key = platformId）。 */
type Results = Record<string, SyncOutcome>;

/* -- 分类 / 同步方式的展示元信息 -------------------------------------- */

const CATEGORY_LABELS: Record<PlatformCategory, string> = {
  mainstream: "主流自媒体",
  tech: "技术社区",
  general: "通用平台",
  finance: "财经平台",
  cms: "建站/CMS",
  overseas: "海外平台",
  special: "特殊下载",
};

const CATEGORY_COLORS: Record<PlatformCategory, string> = {
  mainstream: "var(--gt-blue)",
  tech: "var(--gt-yellow)",
  general: "var(--gt-green)",
  finance: "var(--gt-pink)",
  cms: "var(--gt-muted)",
  overseas: "var(--gt-red)",
  special: "var(--gt-muted)",
};

const SYNC_LABELS: Record<SyncMode, string> = {
  api: "API",
  dom: "DOM",
  "zip-download": "下载",
};

/** 分类标签栏："" 表示「全部」。 */
const TABS: { key: PlatformCategory | ""; label: string }[] = [
  { key: "", label: "全部" },
  { key: "mainstream", label: "主流自媒体" },
  { key: "tech", label: "技术社区" },
  { key: "general", label: "通用平台" },
  { key: "finance", label: "财经平台" },
  { key: "cms", label: "建站/CMS" },
  { key: "overseas", label: "海外平台" },
  { key: "special", label: "特殊下载" },
];

/** 常用组合（id 均来自注册表，已核对存在）。 */
const COMBOS: { label: string; ids: string[] }[] = [
  { label: "技术三件套", ids: ["zhihu", "juejin", "csdn"] },
  { label: "自媒体全覆盖", ids: ["weixin", "zhihu", "weibo", "xiaohongshu", "toutiao"] },
  { label: "技术+社区", ids: ["zhihu", "juejin", "csdn", "segmentfault", "oschina"] },
];

/** 平台墙 = 注册表全部 + 稿台自有 feishu。 */
const FEISHU_META: PlatformMeta = {
  id: "feishu",
  name: "飞书",
  homepage: "https://www.feishu.cn",
  category: "general",
  capabilities: ["article", "draft", "image_upload"],
  syncMode: "dom",
};

const ALL_PLATFORMS: PlatformMeta[] = [...getAllPlatforms(), FEISHU_META];

/** 卡片角标文字：取名称首字符（拉丁字母转大写）。 */
function platformMark(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

export function MultiPlatformPanel() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<PlatformCategory | "">("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<BridgeStatus>({ running: false, port: 0, clients: 0 });
  // 真正决定能不能发稿的是「有没有扩展会话」，不是后端连没连上桥。
  const connected = (status.extensions ?? 0) > 0;
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Results>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const aliveRef = useRef(true);

  // 搜索 + 分类组合过滤：分类先筛，再按名称/ID 模糊匹配（大小写不敏感）。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ALL_PLATFORMS.filter((p) => {
      if (category && p.category !== category) return false;
      if (!q) return true;
      return p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
    });
  }, [search, category]);

  // 加载稿件列表。
  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { projects?: Project[] };
      const list = body.projects ?? [];
      setProjects(list);
      setProjectId((current) => current || (list.find((p) => p.stage === "article")?.id ?? ""));
    } catch {
      setError("稿件列表读取失败");
    }
  }, []);

  // 轮询连接状态。
  const pollStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/bridge/status", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as BridgeStatus;
      if (aliveRef.current) setStatus(body);
    } catch {
      if (aliveRef.current) setStatus({ running: false, port: 0, clients: 0 });
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void loadProjects();
    void pollStatus();
    const timer = window.setInterval(() => void pollStatus(), 3000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [loadProjects, pollStatus]);

  // 轮询单个任务结果，返回最终 outcome。
  const pollTask = useCallback((taskId: string) => {
    return new Promise<SyncOutcome>((resolve) => {
      let attempts = 0;
      const check = async () => {
        if (attempts > 30) {
          resolve({ status: "failed", result: { ok: false, reason: "等待超时（30s）" } });
          return;
        }
        attempts += 1;
        try {
          const response = await fetch(`/api/bridge/task?taskId=${encodeURIComponent(taskId)}`, {
            cache: "no-store",
          });
          const body = (await response.json().catch(() => ({}))) as SyncOutcome & { error?: string };
          if (body.status === "done" || body.status === "failed") {
            resolve({ status: body.status, result: body.result });
            return;
          }
          if (body.error) {
            resolve({ status: "failed", result: { ok: false, reason: body.error } });
            return;
          }
          window.setTimeout(() => void check(), 1000);
        } catch {
          window.setTimeout(() => void check(), 1000);
        }
      };
      void check();
    });
  }, []);

  // 同步单个平台（POST /api/bridge/sync + 轮询）。
  const syncOne = useCallback(
    async (platformId: string): Promise<SyncOutcome> => {
      if (aliveRef.current) setResults((prev) => ({ ...prev, [platformId]: { status: "pending" } }));
      try {
        const response = await fetch("/api/bridge/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: platformId, projectId }),
        });
        const body = (await response.json().catch(() => ({}))) as { ok?: boolean; taskId?: string; error?: string };
        if (!body.ok || !body.taskId) {
          return { status: "failed", result: { ok: false, reason: body.error ?? "推送失败" } };
        }
        return await pollTask(body.taskId);
      } catch {
        return { status: "failed", result: { ok: false, reason: "推送请求失败" } };
      }
    },
    [projectId, pollTask],
  );

  // 批量同步：按已选平台逐个串行推送。
  const push = async () => {
    if (selected.size === 0 || !projectId) return;
    setBusy(true);
    setError("");
    setNotice("");
    setResults({});
    const ids = [...selected];
    for (const id of ids) {
      const outcome = await syncOne(id);
      if (aliveRef.current) setResults((prev) => ({ ...prev, [id]: outcome }));
    }
    if (aliveRef.current) setBusy(false);
  };

  // 切换单个平台选中/取消。
  const togglePlatform = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 应用常用组合（替换当前选择）。
  const applyCombo = (ids: string[]) => setSelected(new Set(ids));

  const selectedList = ALL_PLATFORMS.filter((p) => selected.has(p.id));

  return (
    <div className={styles.wrap}>
      <div className={styles.statusRow}>
        <span className={styles.status}>
          <span
            className={styles.statusDot}
            style={{ background: connected ? "var(--gt-green)" : "var(--gt-yellow)" }}
          />
          {connected ? "插件已连接" : "插件未连接"}
        </span>
        <span className={styles.statusMeta}>
          {connected
            ? `桥接端口 ${status.port} · ${status.extensions} 个扩展会话`
            : "没有插件收不到稿子，先在「插件安装」装好并检测通过"}
        </span>
        <Link href="/publish/extension" className={styles.guideLink}>
          {connected ? "查看插件" : "去安装 / 检测 →"}
        </Link>
      </div>

      {/* 顶部：搜索框 */}
      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.search}
          placeholder="搜索平台名称或 ID…"
          value={search}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          aria-label="搜索平台"
        />
      </div>

      {/* 分类标签栏 */}
      <div className={styles.tabs} role="tablist" aria-label="平台分类">
        {TABS.map((tab) => (
          <button
            key={tab.key || "all"}
            type="button"
            role="tab"
            aria-selected={category === tab.key}
            className={`${styles.tab}${category === tab.key ? ` ${styles.tabActive}` : ""}`}
            onClick={() => setCategory(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 常用组合 */}
      <div className={styles.combos}>
        <span className={styles.combosLabel}>常用组合：</span>
        {COMBOS.map((combo) => (
          <button
            key={combo.label}
            type="button"
            className={styles.comboBtn}
            onClick={() => applyCombo(combo.ids)}
          >
            {combo.label}
          </button>
        ))}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>
          选择平台
          <span className={styles.count}>{filtered.length} 个</span>
        </h2>
        {filtered.length === 0 ? (
          <p className={styles.empty}>没有匹配的平台，试试其他关键词或分类。</p>
        ) : (
          <div className={styles.grid}>
            {filtered.map((platform) => {
              const isActive = selected.has(platform.id);
              return (
                <button
                  key={platform.id}
                  type="button"
                  aria-pressed={isActive}
                  className={`${styles.card}${isActive ? ` ${styles.cardActive}` : ""}`}
                  onClick={() => togglePlatform(platform.id)}
                >
                  <div className={styles.cardTop}>
                    <span className={styles.cardMark} style={{ background: CATEGORY_COLORS[platform.category] }}>
                      {platformMark(platform.name)}
                    </span>
                    <span className={styles.cardCheck}>{isActive ? "✓" : ""}</span>
                  </div>
                  <span className={styles.cardName}>{platform.name}</span>
                  <span className={styles.cardMeta}>
                    <span className={styles.cardCat}>{CATEGORY_LABELS[platform.category]}</span>
                    <span className={styles.cardSync}>{SYNC_LABELS[platform.syncMode]}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>选择稿件</h2>
        <select
          className="gt-select"
          value={projectId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setProjectId(e.target.value)}
          disabled={projects.length === 0}
        >
          <option value="">{projects.length === 0 ? "暂无稿件" : "选择一篇…"}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.stage === "article" ? "● " : ""}
              {project.title}
            </option>
          ))}
        </select>
        <p className="gt-hint">只推送已有正文的稿件；带 ● 的是已定稿的。</p>
      </div>

      {/* 底部：已选平台栏（sticky，始终可见） */}
      <div className={styles.selectedBar}>
        <div className={styles.selectedInfo}>
          <span className={styles.selectedCount}>已选 {selected.size} 个平台</span>
          {selectedList.length > 0 ? (
            <div className={styles.chips}>
              {selectedList.map((platform) => (
                <span key={platform.id} className={styles.chip}>
                  {platform.name}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={`移除 ${platform.name}`}
                    onClick={() => togglePlatform(platform.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <span className={styles.selectedHint}>点击上方卡片选择要同步的平台</span>
          )}
        </div>
        <button
          className="gt-btn gt-btn--primary gt-btn--lg"
          type="button"
          disabled={busy || selected.size === 0 || !projectId}
          onClick={() => void push()}
        >
          {busy ? "同步中…" : `同步到选中平台（${selected.size}）`}
        </button>
      </div>

      {notice ? <div className={styles.notice}>{notice}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}

      {/* 各平台同步结果 */}
      {Object.keys(results).length > 0 ? (
        <div className={styles.resultList}>
          {ALL_PLATFORMS.filter((p) => p.id in results).map((platform) => {
            const outcome = results[platform.id];
            const done = outcome.status === "done";
            return (
              <div
                key={platform.id}
                className={`${styles.result} ${done ? styles.resultOk : styles.resultFail}`}
              >
                <strong>{platform.name}</strong>
                <p>
                  {done
                    ? outcome.result?.url
                      ? `文章地址：${outcome.result.url}`
                      : "已填入编辑器。"
                    : outcome.result?.reason ?? "推送失败"}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
