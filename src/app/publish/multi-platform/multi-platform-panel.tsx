"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./multi-platform.module.css";

/**
 * 多平台分发面板（客户端组件）。
 *
 * 流程：选平台 → 选稿件 → 点「推送」→ POST /api/bridge/sync 拿 taskId →
 * 轮询 /api/bridge/task 直到 done/failed → 展示结果。
 *
 * 连接状态通过轮询 GET /api/bridge/status 获取（WS 桥由 Electron 主进程起，
 * 后端子进程以客户端身份连上）。扩展未连上时显示「请安装浏览器扩展」。
 */

type Project = { id: string; title: string; stage: string };

type PlatformMeta = {
  id: string;
  name: string;
  mark: string;
  color: string;
  hint: string;
};

const PLATFORMS: PlatformMeta[] = [
  { id: "zhihu", name: "知乎", mark: "知", color: "var(--gt-blue)", hint: "富文本编辑器" },
  { id: "juejin", name: "掘金", mark: "掘", color: "var(--gt-yellow)", hint: "Markdown 编辑器" },
  { id: "csdn", name: "CSDN", mark: "C", color: "var(--gt-red)", hint: "富文本编辑器" },
  { id: "xiaohongshu", name: "小红书", mark: "红", color: "var(--gt-pink)", hint: "图文发布页" },
  { id: "feishu", name: "飞书", mark: "飞", color: "var(--gt-green)", hint: "文档编辑器" },
];

type BridgeStatus = { running: boolean; port: number; clients: number };

type SyncTask = {
  status: "pending" | "delivered" | "done" | "failed";
  result?: { ok?: boolean; url?: string; reason?: string };
};

export function MultiPlatformPanel() {
  const [selected, setSelected] = useState<string>("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<BridgeStatus>({ running: false, port: 0, clients: 0 });
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<SyncTask | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pollRef = useRef<number | null>(null);

  // 加载稿件列表。
  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const body = (await response.json()) as { projects?: Project[] };
      const list = body.projects ?? [];
      setProjects(list);
      setProjectId(current => current || (list.find(p => p.stage === "article")?.id ?? ""));
    } catch {
      setError("稿件列表读取失败");
    }
  }, []);

  // 轮询连接状态。
  const pollStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/bridge/status", { cache: "no-store" });
      const body = (await response.json()) as BridgeStatus;
      setStatus(body);
    } catch {
      setStatus({ running: false, port: 0, clients: 0 });
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void pollStatus();
    const timer = window.setInterval(() => void pollStatus(), 3000);
    return () => window.clearInterval(timer);
  }, [loadProjects, pollStatus]);

  // 轮询任务结果。
  const pollTask = useCallback(async (taskId: string) => {
    let attempts = 0;
    const check = async () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      if (attempts > 30) {
        setTask({ status: "failed", result: { ok: false, reason: "等待超时（30s）" } });
        setBusy(false);
        return;
      }
      attempts += 1;
      try {
        const response = await fetch(`/api/bridge/task?taskId=${encodeURIComponent(taskId)}`, {
          cache: "no-store",
        });
        const body = (await response.json()) as SyncTask & { error?: string };
        if (body.status === "done" || body.status === "failed") {
          setTask({ status: body.status, result: body.result });
          setBusy(false);
          return;
        }
        if (body.error) {
          setTask({ status: "failed", result: { ok: false, reason: body.error } });
          setBusy(false);
          return;
        }
        pollRef.current = window.setTimeout(check, 1000);
      } catch {
        pollRef.current = window.setTimeout(check, 1000);
      }
    };
    await check();
  }, []);

  const push = async () => {
    if (!selected || !projectId) return;
    setBusy(true);
    setError("");
    setNotice("");
    setTask(null);
    try {
      const response = await fetch("/api/bridge/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: selected, projectId }),
      });
      const body = (await response.json()) as { ok?: boolean; taskId?: string; error?: string };
      if (!body.ok || !body.taskId) {
        setError(body.error ?? "推送失败");
        setBusy(false);
        return;
      }
      setNotice("已推送给浏览器扩展，等待填入编辑器…");
      void pollTask(body.taskId);
    } catch {
      setError("推送请求失败");
      setBusy(false);
    }
  };

  const selectedMeta = PLATFORMS.find(p => p.id === selected);

  return (
    <div className={styles.wrap}>
      <div className={styles.statusRow}>
        <span className={styles.status}>
          <span
            className={styles.statusDot}
            style={{ background: status.running ? "var(--gt-green)" : "var(--gt-muted)" }}
          />
          {status.running ? "已连接" : "请安装浏览器扩展"}
        </span>
        <span className={styles.statusMeta}>
          {status.running && status.port
            ? `端口 ${status.port} · ${status.clients} 客户端`
            : "扩展连接后自动重连"}
        </span>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>选择平台</h2>
        <div className={styles.grid}>
          {PLATFORMS.map(platform => (
            <button
              key={platform.id}
              type="button"
              className={`${styles.card}${selected === platform.id ? ` ${styles.cardActive}` : ""}`}
              onClick={() => setSelected(platform.id)}
            >
              <span className={styles.cardMark} style={{ background: platform.color }}>
                {platform.mark}
              </span>
              <span className={styles.cardName}>{platform.name}</span>
              <span className={styles.cardHint}>{platform.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>选择稿件</h2>
        <select
          className="gt-select"
          value={projectId}
          onChange={e => setProjectId(e.target.value)}
          disabled={projects.length === 0}
        >
          <option value="">{projects.length === 0 ? "暂无稿件" : "选择一篇…"}</option>
          {projects.map(project => (
            <option key={project.id} value={project.id}>
              {project.stage === "article" ? "● " : ""}
              {project.title}
            </option>
          ))}
        </select>
        <p className="gt-hint">只推送已有正文的稿件；带 ● 的是已定稿的。</p>
      </div>

      <div className={styles.actions}>
        <button
          className="gt-btn gt-btn--primary gt-btn--lg"
          type="button"
          disabled={busy || !selected || !projectId}
          onClick={() => void push()}
        >
          {busy ? "推送中…" : `推送到${selectedMeta ? ` ${selectedMeta.name}` : "所选平台"}`}
        </button>
      </div>

      {notice ? <div className={styles.notice}>{notice}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}

      {task ? (
        <div className={`${styles.result} ${task.status === "done" ? styles.resultOk : styles.resultFail}`}>
          <strong>{task.status === "done" ? "已填入编辑器" : "推送失败"}</strong>
          <p>
            {task.status === "done"
              ? task.result?.url
                ? `文章地址：${task.result.url}`
                : "请到浏览器目标平台检查内容是否已填入。"
              : task.result?.reason ?? "未知错误"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
