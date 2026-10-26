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
 * 导入一篇已有的文章。
 *
 * 这是给「文章早就写好了，只想排一下版、发到草稿箱」用的：
 * 粘进来直接进正文阶段，前面的三道工序全跳过。
 *
 * 收成折叠的：平时不占地方，要用的时候点开。
 */
export default function ImportProjectPanel({ topics }: { topics: TopicOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [topicId, setTopicId] = useState(topics[0]?.id ?? "general");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function onImport(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!content.trim()) {
      setError("先把文章贴进来。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/projects/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, topicId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "导入失败。");
      if (body.converted) {
        setNotice(`已把 ${body.converted} 处 HTML 转成 Markdown，正文 ${body.hanCount} 字。`);
      }
      router.push(`/projects/${body.project.id}`);
      router.refresh();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "导入失败。");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className="gt-panel gt-panel--flat">
        <div className="gt-row gt-row--between">
          <div>
            <h2 className="gt-heading" style={{ margin: 0 }}>
              已经有文章了？
            </h2>
            <p className="gt-small gt-muted" style={{ margin: "4px 0 0" }}>
              把写好的文章贴进来，跳过前面三道工序，直接排版、配封面、发草稿箱。
            </p>
          </div>
          <button className="gt-btn" type="button" onClick={() => setOpen(true)}>
            排版已有文章
          </button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={onImport} className="gt-panel gt-stack" style={{ maxWidth: "720px" }}>
      <div className="gt-row gt-row--between">
        <div>
          <h2 className="gt-heading" style={{ margin: 0 }}>
            排版已有文章
          </h2>
          <p className="gt-small gt-muted" style={{ margin: "4px 0 0" }}>
            贴 Markdown 就行；从公众号后台复制的 HTML 也能贴，会自动洗成 Markdown。
          </p>
        </div>
        <button className="gt-btn gt-btn--sm gt-btn--ghost" type="button" onClick={() => setOpen(false)}>
          收起
        </button>
      </div>

      <label className="gt-field">
        <span className="gt-label">文章正文</span>
        <textarea
          className="gt-textarea gt-textarea--mono gt-scroll"
          rows={12}
          value={content}
          onChange={event => setContent(event.target.value)}
          placeholder={"# 标题\n\n第一段正文。\n\n![图片](https://…)"}
        />
      </label>

      <div className="gt-grid gt-grid--2">
        <label className="gt-field">
          <span className="gt-label">标题（留空就从文章里取）</span>
          <input
            className="gt-input"
            value={title}
            onChange={event => setTitle(event.target.value)}
            placeholder="例如：一次迁移失败的复盘"
          />
        </label>
        <label className="gt-field">
          <span className="gt-label">属于哪个专题</span>
          <select className="gt-select" value={topicId} onChange={event => setTopicId(event.target.value)}>
            {topics.map(topic => (
              <option key={topic.id} value={topic.id}>
                {topic.name}
                {topic.source === "local" ? "（本地）" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

      <div className="gt-row gt-row--end">
        <button className="gt-btn gt-btn--primary" type="submit" disabled={busy || !content.trim()}>
          {busy ? "导入中…" : "导入并去排版"}
        </button>
      </div>
    </form>
  );
}
