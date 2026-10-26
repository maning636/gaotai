"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type LocalImage = { path: string; size: number; mtime: string; url: string };

/** 单张图片的上限。微信正文插图 1MB 以内最稳，封面 10MB。 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 素材库：本地配图。 */
export default function FilesPanel() {
  const [images, setImages] = useState<LocalImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/files", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "读取素材失败。");
      setImages(Array.isArray(body) ? body : []);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取素材失败。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 上传图片。
   *
   * 图从外面来（别的工具生图、自己截的图、拍的照片），先存进本机素材库，
   * 正文里再用 `/api/files/img/…` 引用它 —— 推草稿时稿台会逐张换成微信自己的地址。
   */
  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(`「${file.name}」超过 10MB，压缩一下再传。`);
        }
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/files", { method: "POST", body: form });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `「${file.name}」上传失败。`);
      }
      setNotice(`传了 ${files.length} 张图。`);
      await load();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "上传失败。");
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  }

  async function onDelete(path: string) {
    if (busy) return;
    if (!window.confirm("删掉这张图？正文里引用它的地方会变成空链接。")) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "删除失败。");
      setNotice("已删除。");
      await load();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "删除失败。");
    } finally {
      setBusy(false);
    }
  }

  async function onCopyUrl(image: LocalImage) {
    try {
      await navigator.clipboard.writeText(image.url);
      setNotice("图片地址已复制，粘进正文就能用。");
    } catch {
      setError("复制失败。");
    }
  }

  async function onCopyMarkdown(image: LocalImage) {
    try {
      await navigator.clipboard.writeText(`![配图](${image.url})`);
      setNotice("Markdown 引用已复制，粘进正文就能用。");
    } catch {
      setError("复制失败。");
    }
  }

  return (
    <div className="gt-stack gt-stack--lg">
      <div className="gt-row gt-row--between">
        <div className="gt-small gt-muted">
          图从外面来（别的工具生图、截图、照片）。先传进素材库，正文里再引用它。
        </div>
        <div className="gt-row" style={{ gap: "8px" }}>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            style={{ display: "none" }}
            onChange={onUpload}
          />
          <button
            className="gt-btn gt-btn--primary gt-btn--sm"
            type="button"
            onClick={() => picker.current?.click()}
            disabled={busy}
          >
            {busy ? "上传中…" : "上传图片"}
          </button>
        </div>
      </div>

      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

      {images.length === 0 ? (
        <div className="gt-empty">
          <span className="gt-empty__mark">空</span>
          还没有本地配图。在上面传一张，或在稿件里用「插入图片」。
        </div>
      ) : (
        <div className="gt-grid gt-grid--3">
          {images.map(image => (
            <div className="gt-panel gt-panel--flat gt-stack gt-stack--sm" key={image.path}>
              <img
                src={image.url}
                alt={image.path}
                style={{
                  width: "100%",
                  aspectRatio: "3 / 2",
                  // 素材库里有横版也有竖版，裁切会把竖图切掉，所以改成完整显示。
                  objectFit: "contain",
                  background: "#fff",
                  border: "2px solid var(--gt-line)",
                  display: "block",
                }}
              />
              <div className="gt-small gt-mono gt-muted" style={{ wordBreak: "break-all" }}>
                {image.path}
              </div>
              <div className="gt-row" style={{ gap: "8px" }}>
                <span className="gt-small gt-muted">{(image.size / 1024).toFixed(0)} KB</span>
                <span className="gt-spacer" />
                <button className="gt-btn gt-btn--sm" type="button" onClick={() => onCopyMarkdown(image)}>
                  复制引用
                </button>
                <button className="gt-btn gt-btn--sm" type="button" onClick={() => onCopyUrl(image)}>
                  复制地址
                </button>
                <button className="gt-btn gt-btn--sm gt-btn--danger" type="button" onClick={() => onDelete(image.path)} disabled={busy}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
