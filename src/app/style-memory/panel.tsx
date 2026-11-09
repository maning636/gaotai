"use client";

import { useCallback, useEffect, useState } from "react";

type Topic = { id: string; name: string; description: string; source: "public" | "local" };

/**
 * 风格画像面板。
 *
 * 画像不是让人「读」的，是给模型「学」的。所以这一页的重点是：
 * 1. 清楚告诉你样本攒够没有；
 * 2. 让你看到模型实际会读到的那段文字；
 * 3. 让你能随时重算——改得越多，画像越准。
 */
export default function StyleMemoryPanel() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicId, setTopicId] = useState("");
  const [profile, setProfile] = useState("");
  const [editCount, setEditCount] = useState(0);
  const [busy, setBusy] = useState<"" | "load" | "refresh">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadProfile = useCallback(async (id: string) => {
    if (!id) return;
    setBusy("load");
    setError("");
    try {
      const response = await fetch(`/api/style-memory?topicId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "读取失败。");
      setProfile(body.profile ?? "");
      setEditCount(body.editCount ?? 0);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取风格画像失败。");
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/topics", { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? "读取专题失败。");
        const list: Topic[] = body.topics ?? [];
        setTopics(list);
        if (list.length) {
          setTopicId(list[0].id);
          void loadProfile(list[0].id);
        }
      } catch (issue) {
        setError(issue instanceof Error ? issue.message : "读取专题失败。");
      }
    })();
  }, [loadProfile]);

  async function onRefresh() {
    if (busy || !topicId) return;
    setBusy("refresh");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/style-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "生成失败。");
      setProfile(body.profile ?? "");
      setEditCount(body.editCount ?? 0);
      setNotice("画像已更新。之后每一道工序都会带上它。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "生成风格画像失败。");
    } finally {
      setBusy("");
    }
  }

  const selected = topics.find(topic => topic.id === topicId);
  const ready = editCount >= 6;

  return (
    <div className="gt-stack gt-stack--lg">
      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

      <section className="gt-panel gt-panel--flat gt-stack">
        <div className="gt-panel__head">
          <div>
            <h2 className="gt-panel__title">风格来自你亲手改的地方</h2>
            <p className="gt-small gt-muted" style={{ margin: "4px 0 0" }}>
              AI 写了什么不算数，你把它改成什么样才算数。每次改动都会被记下来，攒够了自动提炼成画像。
            </p>
          </div>
        </div>

        <div className="gt-row">
          <label className="gt-field" style={{ minWidth: "240px" }}>
            <span className="gt-label">专题</span>
            <select
              className="gt-select"
              value={topicId}
              onChange={event => {
                setTopicId(event.target.value);
                void loadProfile(event.target.value);
              }}
            >
              {topics.map(topic => (
                <option key={topic.id} value={topic.id}>
                  {topic.name}
                </option>
              ))}
            </select>
          </label>
          <span className={`gt-tag ${ready ? "gt-tag--green" : "gt-tag--yellow"}`}>
            已积累 {editCount} 次修改
          </span>
          <button className="gt-btn gt-btn--primary" type="button" onClick={onRefresh} disabled={busy !== "" || !topicId}>
            {busy === "refresh" ? "分析中…" : "重新提炼画像"}
          </button>
        </div>

        {selected?.description ? <p className="gt-small gt-muted" style={{ margin: 0 }}>{selected.description}</p> : null}
      </section>

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">模型实际会读到的画像</h2>
          <span className="gt-small gt-muted">
            {busy === "load" ? "读取中…" : profile ? "已生效" : "尚未生成"}
          </span>
        </div>
        {profile ? (
          <pre className="gt-code gt-scroll" style={{ maxHeight: "420px", margin: 0, whiteSpace: "pre-wrap" }}>
            {profile}
          </pre>
        ) : (
          <div className="gt-empty">
            <span className="gt-empty__mark">?</span>
            {ready ? "样本够了，点「重新提炼画像」生成。" : `还差 ${Math.max(0, 6 - editCount)} 次修改。`}
          </div>
        )}
      </section>
    </div>
  );
}
