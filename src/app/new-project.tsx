"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type TopicOption = {
  id: string;
  name: string;
  description: string;
  audience: string;
  source: "public" | "local";
};

/**
 * 新建稿件。
 *
 * 专题在这里选：它决定了这篇稿子之后每一道工序的写作规则，
 * 相当于给 AI 定好了「这次用什么口吻写」。
 */
export default function NewProjectPanel({ topics }: { topics: TopicOption[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [topicId, setTopicId] = useState(topics[0]?.id ?? "general");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, topicId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "新建失败。");
        return;
      }
      router.push(`/projects/${body.project.id}`);
    } catch {
      setError("无法连接到本地服务。");
    } finally {
      setBusy(false);
    }
  }

  const selected = topics.find(topic => topic.id === topicId);

  return (
    <form onSubmit={onCreate} className="gt-panel gt-stack" style={{ maxWidth: "620px" }}>
      <div>
        <h2 className="gt-heading">开一篇新稿</h2>
        <p className="gt-small gt-muted" style={{ margin: 0 }}>
          先把素材丢进来，AI 会从材料解读开始一步步往下走。
        </p>
      </div>

      <label className="gt-field">
        <span className="gt-label">这篇稿子属于哪个专题</span>
        <select className="gt-select" value={topicId} onChange={event => setTopicId(event.target.value)}>
          {topics.map(topic => (
            <option key={topic.id} value={topic.id}>
              {topic.name}
              {topic.source === "local" ? "（本地）" : ""}
            </option>
          ))}
        </select>
        {selected ? (
          <span className="gt-hint">
            {selected.description}
            {selected.audience ? ` —— 写给：${selected.audience}` : ""}
          </span>
        ) : null}
      </label>

      <label className="gt-field">
        <span className="gt-label">标题（可以先空着）</span>
        <input
          className="gt-input"
          value={title}
          onChange={event => setTitle(event.target.value)}
          placeholder="例如：一次迁移失败的复盘"
        />
      </label>

      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}

      <div className="gt-row gt-row--end">
        <button className="gt-btn gt-btn--primary" type="submit" disabled={busy || !topicId}>
          {busy ? "创建中…" : "创建稿件"}
        </button>
      </div>
    </form>
  );
}
