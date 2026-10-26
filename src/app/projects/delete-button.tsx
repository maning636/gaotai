"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** 删除按钮单独成组件：列表页是服务端组件，只有这个小块需要交互。 */
export function DeleteProjectButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onDelete() {
    if (busy) return;
    if (!window.confirm(`确定删除「${title}」？这一篇的阶段产出、对话和修改记录都会一起删掉。`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "删除失败。");
        return;
      }
      router.refresh();
    } catch {
      setError("无法连接到本地服务。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="gt-row" style={{ gap: "8px" }}>
      {error ? <span className="gt-error">{error}</span> : null}
      <button className="gt-btn gt-btn--sm gt-btn--danger" type="button" onClick={onDelete} disabled={busy}>
        {busy ? "删除中…" : "删除"}
      </button>
    </span>
  );
}
