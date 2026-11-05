"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Tab = "image" | "video" | "draft";

type Project = { id: string; title: string; stage: string };
type LocalImage = { path: string; size: number; mtime: string; url: string };
type LocalVideo = { path: string; size: number; mtime: string; url: string };
type Cover = { configured: boolean; image: string; previewUrl: string };
/** 公众号通道的检查结果。ok 为 false 时 reason/hint 说清是什么问题、下一步做什么。 */
type ChannelCheck = {
  ok: boolean;
  reason: string;
  hint: string;
  egressIp?: string;
};
/** 文案库里的一条。project_id 允许为空：很多文案独立写，不挂靠稿子。 */
type Draft = {
  id: string;
  title: string;
  content: string;
  category: string;
  project_id: string | null;
  created_at: number;
  updated_at: number;
};

/** 取相对路径最后一段当显示名：UI 上只露文件名，不露全路径。 */
function baseName(rel: string): string {
  return rel.split("/").pop() ?? rel;
}

/** 体积转成能直接读的数：视频是 MB 级，图片是 KB 级，按量级选单位。 */
function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 发布页：图、视频、文案三件事分三个 Tab。 */
export default function PublishPanel() {
  const [tab, setTab] = useState<Tab>("image");

  return (
    <div className="gt-stack gt-stack--lg">
      <div className="gt-tabs" role="tablist">
        <button
          className={`gt-tabs__tab ${tab === "image" ? "gt-tabs__tab--active" : ""}`}
          type="button"
          role="tab"
          aria-selected={tab === "image"}
          onClick={() => setTab("image")}
        >
          图文上传
        </button>
        <button
          className={`gt-tabs__tab ${tab === "video" ? "gt-tabs__tab--active" : ""}`}
          type="button"
          role="tab"
          aria-selected={tab === "video"}
          onClick={() => setTab("video")}
        >
          视频上传
        </button>
        <button
          className={`gt-tabs__tab ${tab === "draft" ? "gt-tabs__tab--active" : ""}`}
          type="button"
          role="tab"
          aria-selected={tab === "draft"}
          onClick={() => setTab("draft")}
        >
          文案上传
        </button>
      </div>

      {tab === "image" ? <ImageTab /> : null}
      {tab === "video" ? <VideoTab /> : null}
      {tab === "draft" ? <DraftTab /> : null}
    </div>
  );
}

/**
 * 图文上传区：配封面 → 填标题/摘要/正文 → 推到草稿箱。
 *
 * 推到草稿箱走的是 `/api/wechat/draft`，它要求 `projectId` 且正文取自
 * 那篇稿件的「文章正文」阶段——所以这里必须先选一篇稿件；正文输入框里
 * 写的内容会在推送前存回稿件的文章正文阶段，推送才真正用得上它。
 */
function ImageTab() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [digest, setDigest] = useState("");
  const [content, setContent] = useState("");
  const [cover, setCover] = useState<Cover>({ configured: false, image: "", previewUrl: "" });
  const [images, setImages] = useState<LocalImage[]>([]);
  const [libraryPick, setLibraryPick] = useState("");
  const [channel, setChannel] = useState<ChannelCheck | null>(null);
  const [busy, setBusy] = useState<"" | "cover" | "push" | "test">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const loadCover = useCallback(async () => {
    try {
      const response = await fetch("/api/wechat/cover", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "读取封面失败。");
      setCover({
        configured: Boolean(body.configured),
        image: body.image ?? "",
        previewUrl: body.previewUrl ?? "",
      });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取封面失败。");
    }
  }, []);

  const loadImages = useCallback(async () => {
    try {
      const response = await fetch("/api/files", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) return;
      setImages(Array.isArray(body) ? body : []);
    } catch {
      // 素材列表读不到不影响主流程
    }
  }, []);

  useEffect(() => {
    void loadCover();
    void loadImages();
    (async () => {
      try {
        const response = await fetch("/api/projects", { cache: "no-store" });
        const body = await response.json();
        const list: Project[] = body.projects ?? [];
        setProjects(list);
        const ready = list.find(project => project.stage === "article");
        if (ready) setProjectId(ready.id);
      } catch {
        // 稿件列表读不到不影响配置区
      }
    })();
    // 打开就测一次通道：用户最想知道的不是「配没配」，是「能不能用」。
    let alive = true;
    (async () => {
      try {
        const response = await fetch("/api/wechat/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = await response.json();
        if (alive && body && typeof body.ok === "boolean") setChannel(body);
      } catch {
        // 测不了就先不管，用户可手动点「测试连接」。
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadCover, loadImages]);

  // 换一篇稿件，就把它的文章正文捞进输入框——用户改的正文是存回这篇里的。
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("读取稿件失败"))))
      .then((body: { current?: { stage: string; content: string } }) => {
        if (alive && body.current?.stage === "article" && body.current.content) {
          setContent(body.current.content);
        }
      })
      .catch(() => {
        // 正文读不到就留空，推送时后端会再拦一道。
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  /** 测一次通道：只测不存。 */
  async function onTestChannel() {
    if (busy) return;
    setBusy("test");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "测试失败。");
      const result: ChannelCheck = body;
      setChannel(result);
      if (result.ok) setNotice("通道测试通过，可以推到草稿箱了。");
      else setWarning(`${result.reason}。${result.hint}`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "测试失败。");
    } finally {
      setBusy("");
    }
  }

  /** 从本机选一张图，上传进素材库。 */
  async function onUploadImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    setBusy("cover");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/files", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "上传失败。");
      setNotice(`「${file.name}」已进素材库。`);
      await loadImages();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "上传失败。");
    } finally {
      setBusy("");
    }
  }

  /** 用素材库里已有的图设为封面。 */
  async function onUseLibraryImage() {
    if (!libraryPick || busy) return;
    setBusy("cover");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: libraryPick }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "设置封面失败。");
      setCover({ configured: true, image: body.image ?? "", previewUrl: body.previewUrl ?? "" });
      setNotice("封面已更新。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "设置封面失败。");
    } finally {
      setBusy("");
    }
  }

  async function onClearCover() {
    if (busy) return;
    setBusy("cover");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/cover", { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "清空封面失败。");
      setCover({ configured: false, image: "", previewUrl: "" });
      setNotice("封面已清空。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "清空封面失败。");
    } finally {
      setBusy("");
    }
  }

  /**
   * 推到草稿箱。
   *
   * 正文是推送前存回稿件的文章正文阶段——`/api/wechat/draft` 不从请求体
   * 读正文，只从稿件的 article 阶段取。所以这里先 PATCH 再推。
   */
  async function onPushDraft() {
    if (busy) return;
    if (!projectId) {
      setError("先选一篇稿件——草稿必须挂在一篇稿子上。");
      return;
    }
    if (!cover.configured) {
      setError("还没有封面图。公众号草稿必须带封面，请先在上面设一张。");
      return;
    }
    // 按钮已禁用，这里再拦一道：「先测后发」不只靠一个 disabled 属性守着。
    if (!channel?.ok) {
      setError(
        `公众号通道还没测通：${channel?.reason ?? "还没测过"}。${
          channel?.hint ?? "先在上面点「测试连接」，测通了才能推。"
        }`,
      );
      return;
    }
    setBusy("push");
    setError("");
    setNotice("");
    setWarning("");
    try {
      // 正文输入框里写了字，就先存回稿件的文章正文阶段，推送才有内容可推。
      if (content.trim()) {
        const save = await fetch(`/api/projects/${encodeURIComponent(projectId)}/stages/article`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const saveBody = await save.json().catch(() => ({}));
        if (!save.ok) throw new Error(saveBody.error ?? "保存正文失败。");
      }
      const response = await fetch("/api/wechat/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(digest.trim() ? { digest: digest.trim() } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "推送失败。");
      setNotice(`已放进草稿箱：${body.title}`);
      if (body.failedImages?.length) {
        setWarning(
          `有 ${body.failedImages.length} 张图没能上传：${body.failedImages
            .map((item: { ref: string; reason: string }) => `${item.ref}（${item.reason}）`)
            .join("；")}。这些图在公众号里会显示不出来。`,
        );
      }
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "推送失败。");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="gt-stack gt-stack--lg">
      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {warning ? <div className="gt-alert gt-alert--warn">{warning}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">通道</h2>
          <span
            className={`gt-tag ${
              !cover.configured && !channel ? "gt-tag--yellow" : channel?.ok ? "gt-tag--green" : "gt-tag--pink"
            }`}
          >
            {channel?.ok ? "通道已通" : channel ? "通道不通" : "未测试"}
          </span>
          <button
            className="gt-btn gt-btn--sm"
            type="button"
            onClick={() => void onTestChannel()}
            disabled={busy !== ""}
          >
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
        </div>
        <p className="gt-hint" style={{ margin: 0 }}>
          推送前必须先测通公众号通道，没测通「推到草稿箱」不给点。
          {channel && !channel.ok ? ` 当前卡在：${channel.reason}。${channel.hint}` : ""}
          {channel && !channel.ok && channel.egressIp
            ? ` 微信看到的本机出口 IP 是 ${channel.egressIp}，把它加进公众号后台的 IP 白名单即可。`
            : ""}
        </p>
      </section>

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">封面图</h2>
          <span className={`gt-tag ${cover.configured ? "gt-tag--green" : "gt-tag--yellow"}`}>
            {cover.configured ? "已就绪" : "缺封面"}
          </span>
        </div>
        <div className="gt-grid gt-grid--2">
          <div className="gt-stack gt-stack--sm">
            {cover.configured && cover.previewUrl ? (
              <img
                src={cover.previewUrl}
                alt="当前封面"
                style={{
                  maxWidth: "220px",
                  display: "block",
                  border: "3px solid var(--gt-ink)",
                  boxShadow: "var(--gt-shadow)",
                }}
              />
            ) : (
              <p className="gt-hint" style={{ margin: 0 }}>
                公众号草稿必须带一张封面图（永久素材），否则推送会被微信拒掉。
              </p>
            )}
            <div className="gt-row" style={{ gap: "8px", flexWrap: "wrap" }}>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: "none" }}
                onChange={event => void onUploadImage(event)}
              />
              <button
                className="gt-btn"
                type="button"
                disabled={busy !== ""}
                onClick={() => fileInput.current?.click()}
              >
                {busy === "cover" ? "处理中…" : "从本机选一张"}
              </button>
              {cover.configured ? (
                <button className="gt-btn gt-btn--sm" type="button" disabled={busy !== ""} onClick={() => void onClearCover()}>
                  清除封面
                </button>
              ) : null}
            </div>
            <p className="gt-hint" style={{ margin: 0 }}>
              选中的图先存进本机素材库，再设为封面。
            </p>
          </div>
          <div className="gt-stack gt-stack--sm">
            <label className="gt-field">
              <span className="gt-label">或用素材库里已有的图</span>
              <select
                className="gt-select"
                value={libraryPick}
                onChange={event => setLibraryPick(event.target.value)}
                disabled={busy !== "" || images.length === 0}
              >
                <option value="">— 选择 —</option>
                {images.map(image => (
                  <option key={image.path} value={image.path}>
                    {baseName(image.path)}
                  </option>
                ))}
              </select>
            </label>
            <div className="gt-row">
              <button
                className="gt-btn gt-btn--sm"
                type="button"
                disabled={busy !== "" || !libraryPick}
                onClick={() => void onUseLibraryImage()}
              >
                设为封面
              </button>
            </div>
            <p className="gt-hint" style={{ margin: 0 }}>
              素材库里的图是稿台生成的配图和正文插图，共 {images.length} 张。
            </p>
          </div>
        </div>
      </section>

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">推到草稿箱</h2>
        </div>
        <div className="gt-stack">
          <div className="gt-grid gt-grid--2">
            <label className="gt-field">
              <span className="gt-label">稿件</span>
              <select className="gt-select" value={projectId} onChange={event => setProjectId(event.target.value)}>
                <option value="">— 选择一篇稿件 —</option>
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
              <span className="gt-hint">正文取自稿件的「文章正文」阶段，推送前会把你写的正文存回去。</span>
            </label>
            <label className="gt-field">
              <span className="gt-label">标题（覆盖）</span>
              <input
                className="gt-input"
                value={title}
                onChange={event => setTitle(event.target.value)}
                placeholder="不填就用稿件的标题"
                autoComplete="off"
              />
              <span className="gt-hint">留空则用稿件的标题。</span>
            </label>
            <label className="gt-field">
              <span className="gt-label">摘要（digest）</span>
              <input
                className="gt-input"
                value={digest}
                onChange={event => setDigest(event.target.value)}
                placeholder="不填就取正文开头"
                autoComplete="off"
              />
              <span className="gt-hint">留空则取正文开头一段。</span>
            </label>
            <label className="gt-field">
              <span className="gt-label">正文（Markdown）</span>
              <textarea
                className="gt-input gt-textarea"
                rows={12}
                value={content}
                onChange={event => setContent(event.target.value)}
                placeholder="这里写正文；推送前会存回稿件，微信侧按 Markdown 排版。"
              />
            </label>
          </div>
          <div className="gt-row gt-row--end">
            <button
              className="gt-btn gt-btn--primary"
              type="button"
              onClick={() => void onPushDraft()}
              disabled={busy !== "" || !projectId || !cover.configured || !channel?.ok}
            >
              {busy === "push" ? "推送中…" : "推到草稿箱"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * 视频上传区：传进本地视频库 → 选一条 + 填标题/描述 → 上传到微信永久素材。
 *
 * 上传到微信很慢（几百 MB 走家用宽带要好几分钟），所以只做「上传拿 media_id」，
 * 不在这里推草稿——推草稿是秒级的，不该和传视频挤在一个请求里等。
 */
function VideoTab() {
  const [videos, setVideos] = useState<LocalVideo[]>([]);
  const [pick, setPick] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [mediaId, setMediaId] = useState("");
  const [busy, setBusy] = useState<"" | "upload" | "toWechat" | "delete">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/publish/videos", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "读取视频库失败。");
      setVideos(Array.isArray(body) ? body : []);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取视频库失败。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    setBusy("upload");
    setError("");
    setNotice("");
    setMediaId("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/publish/videos", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `「${file.name}」上传失败。`);
      setNotice(`「${file.name}」已进本地视频库。`);
      await load();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "上传失败。");
    } finally {
      setBusy("");
    }
  }

  async function onDelete(path: string) {
    if (busy) return;
    if (!window.confirm("删掉这个视频？上传到微信的素材不受影响。")) return;
    setBusy("delete");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/publish/videos", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "删除失败。");
      setNotice("已删除。");
      if (pick === path) setPick("");
      await load();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "删除失败。");
    } finally {
      setBusy("");
    }
  }

  async function onUploadToWechat() {
    if (busy) return;
    if (!pick) {
      setError("先选一个要上传的视频。");
      return;
    }
    if (!title.trim()) {
      setError("视频标题不能为空——微信要求标题。");
      return;
    }
    if (!description.trim()) {
      setError("视频描述不能为空——微信要求简介。");
      return;
    }
    setBusy("toWechat");
    setError("");
    setNotice("");
    setMediaId("");
    try {
      const response = await fetch("/api/publish/video-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pick, title: title.trim(), description: description.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "上传到微信失败。");
      setMediaId(body.mediaId ?? "");
      setNotice("视频已上传到微信永久素材库。下面拿到 media_id，推草稿时用它。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "上传到微信失败。");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="gt-stack gt-stack--lg">
      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">视频库</h2>
          <div className="gt-row" style={{ gap: "8px" }}>
            <input
              ref={picker}
              type="file"
              accept="video/mp4,video/quicktime,video/x-msvideo,video/x-matroska"
              style={{ display: "none" }}
              onChange={event => void onUpload(event)}
            />
            <button
              className="gt-btn gt-btn--primary gt-btn--sm"
              type="button"
              onClick={() => picker.current?.click()}
              disabled={busy !== ""}
            >
              {busy === "upload" ? "上传中…" : "上传视频"}
            </button>
          </div>
        </div>
        {videos.length === 0 ? (
          <div className="gt-empty">
            <span className="gt-empty__mark">空</span>
            还没有本地视频。上面传一个进来（mp4 / mov / avi / mkv）。
          </div>
        ) : (
          <div className="gt-grid gt-grid--2">
            {videos.map(video => (
              <div className="gt-panel gt-panel--sunken gt-stack gt-stack--sm" key={video.path}>
                <video
                  src={video.url}
                  controls
                  preload="metadata"
                  style={{ width: "100%", display: "block", background: "#000", border: "2px solid var(--gt-line)" }}
                />
                <div className="gt-row gt-row--between">
                  <span className="gt-small" style={{ fontWeight: 700 }}>
                    {baseName(video.path)}
                  </span>
                  <span className="gt-small gt-mono gt-muted">{humanSize(video.size)}</span>
                </div>
                <div className="gt-row">
                  <span className="gt-spacer" />
                  <button className="gt-btn gt-btn--sm" type="button" disabled={busy !== ""} onClick={() => setPick(video.path)}>
                    {pick === video.path ? "已选" : "选这个"}
                  </button>
                  <button
                    className="gt-btn gt-btn--sm gt-btn--danger"
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void onDelete(video.path)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">上传到微信</h2>
        </div>
        <div className="gt-stack">
          <div className="gt-grid gt-grid--2">
            <label className="gt-field">
              <span className="gt-label">选一个视频</span>
              <select className="gt-select" value={pick} onChange={event => setPick(event.target.value)} disabled={videos.length === 0}>
                <option value="">— 选择 —</option>
                {videos.map(video => (
                  <option key={video.path} value={video.path}>
                    {baseName(video.path)}
                  </option>
                ))}
              </select>
            </label>
            <label className="gt-field">
              <span className="gt-label">视频标题（必填）</span>
              <input
                className="gt-input"
                value={title}
                onChange={event => setTitle(event.target.value)}
                placeholder="微信要求标题，最长 100 字"
                autoComplete="off"
              />
            </label>
            <label className="gt-field" style={{ gridColumn: "1 / -1" }}>
              <span className="gt-label">视频描述（必填）</span>
              <textarea
                className="gt-input gt-textarea"
                rows={4}
                value={description}
                onChange={event => setDescription(event.target.value)}
                placeholder="微信要求简介，最长 500 字"
              />
            </label>
          </div>
          <div className="gt-row gt-row--end">
            <button
              className="gt-btn gt-btn--primary"
              type="button"
              onClick={() => void onUploadToWechat()}
              disabled={busy !== "" || !pick || !title.trim() || !description.trim()}
            >
              {busy === "toWechat" ? "上传中…（大视频要等几分钟）" : "上传到微信"}
            </button>
          </div>
          {mediaId ? (
            <p className="gt-hint gt-mono" style={{ margin: 0, wordBreak: "break-all" }}>
              media_id：{mediaId}——推草稿时带上它。
            </p>
          ) : null}
          <p className="gt-hint" style={{ margin: 0 }}>
            上传到微信的是永久素材，走视频专用接口（media/uploadvideo），和图片的 add_material 不同。
          </p>
        </div>
      </section>
    </div>
  );
}

/**
 * 文案上传区：文案的增删改查。
 *
 * 文案是「写好了但还没插进稿子」的片段，落 SQLite。列表按分类筛选，
 * 编辑采用 inline 展开——点「编辑」把卡片换成表单。
 */
function DraftTab() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [category, setCategory] = useState("");
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState({ title: "", content: "", category: "general" });
  const [busy, setBusy] = useState<"" | "create" | "update" | "delete">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async (filter: string) => {
    try {
      const url = filter ? `/api/publish/drafts?category=${encodeURIComponent(filter)}` : "/api/publish/drafts";
      const response = await fetch(url, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "读取文案失败。");
      setDrafts(Array.isArray(body.drafts) ? body.drafts : []);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取文案失败。");
    }
  }, []);

  useEffect(() => {
    void load(category);
  }, [category, load]);

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!form.title.trim() && !form.content.trim()) {
      setError("标题和正文至少填一个。");
      return;
    }
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/publish/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          content: form.content,
          category: form.category.trim() || "general",
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "新建失败。");
      setNotice("文案已新建。");
      setForm({ title: "", content: "", category: "general" });
      setShowCreate(false);
      await load(category);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "新建失败。");
    } finally {
      setBusy("");
    }
  }

  function startEdit(draft: Draft) {
    setEditingId(draft.id);
    setForm({ title: draft.title, content: draft.content, category: draft.category });
    setError("");
    setNotice("");
  }

  async function onUpdate(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!editingId) return;
    setBusy("update");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/publish/drafts/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          content: form.content,
          category: form.category.trim() || "general",
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "保存失败。");
      setNotice("文案已更新。");
      setEditingId("");
      await load(category);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "保存失败。");
    } finally {
      setBusy("");
    }
  }

  async function onDelete(id: string) {
    if (busy) return;
    if (!window.confirm("删掉这条文案？")) return;
    setBusy("delete");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/publish/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "删除失败。");
      setNotice("已删除。");
      if (editingId === id) setEditingId("");
      await load(category);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "删除失败。");
    } finally {
      setBusy("");
    }
  }

  // 分类选项：从已有文案里收集 + 默认 general，去重。
  const categoryOptions = Array.from(new Set(["general", ...drafts.map(draft => draft.category)])).sort();

  return (
    <div className="gt-stack gt-stack--lg">
      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

      <div className="gt-row gt-row--between">
        <div className="gt-row" style={{ gap: "8px" }}>
          <label className="gt-field" style={{ minWidth: "180px", marginBottom: 0 }}>
            <span className="gt-label">按分类筛选</span>
            <select className="gt-select" value={category} onChange={event => setCategory(event.target.value)}>
              <option value="">全部</option>
              {categoryOptions.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="gt-btn gt-btn--primary" type="button" onClick={() => setShowCreate(current => !current)}>
          {showCreate ? "收起" : "新建文案"}
        </button>
      </div>

      {showCreate ? (
        <form onSubmit={onCreate} className="gt-panel gt-panel--sunken gt-stack">
          <div className="gt-grid gt-grid--2">
            <label className="gt-field">
              <span className="gt-label">标题</span>
              <input
                className="gt-input"
                value={form.title}
                onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
                autoComplete="off"
              />
            </label>
            <label className="gt-field">
              <span className="gt-label">分类</span>
              <input
                className="gt-input"
                value={form.category}
                onChange={event => setForm(current => ({ ...current, category: event.target.value }))}
                autoComplete="off"
              />
            </label>
          </div>
          <label className="gt-field">
            <span className="gt-label">正文</span>
            <textarea
              className="gt-input gt-textarea"
              rows={6}
              value={form.content}
              onChange={event => setForm(current => ({ ...current, content: event.target.value }))}
            />
          </label>
          <div className="gt-row gt-row--end">
            <button className="gt-btn" type="button" onClick={() => setShowCreate(false)}>
              取消
            </button>
            <button className="gt-btn gt-btn--primary" type="submit" disabled={busy !== ""}>
              {busy === "create" ? "新建中…" : "新建"}
            </button>
          </div>
        </form>
      ) : null}

      {drafts.length === 0 ? (
        <div className="gt-empty">
          <span className="gt-empty__mark">空</span>
          还没有{category ? `「${category}」分类的` : ""}文案。点「新建文案」写一条。
        </div>
      ) : (
        <div className="gt-grid gt-grid--2">
          {drafts.map(draft => (
            <div className="gt-panel gt-panel--flat gt-stack gt-stack--sm" key={draft.id}>
              {editingId === draft.id ? (
                <form onSubmit={onUpdate} className="gt-stack">
                  <div className="gt-grid gt-grid--2">
                    <label className="gt-field">
                      <span className="gt-label">标题</span>
                      <input
                        className="gt-input"
                        value={form.title}
                        onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
                        autoComplete="off"
                      />
                    </label>
                    <label className="gt-field">
                      <span className="gt-label">分类</span>
                      <input
                        className="gt-input"
                        value={form.category}
                        onChange={event => setForm(current => ({ ...current, category: event.target.value }))}
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <label className="gt-field">
                    <span className="gt-label">正文</span>
                    <textarea
                      className="gt-input gt-textarea"
                      rows={6}
                      value={form.content}
                      onChange={event => setForm(current => ({ ...current, content: event.target.value }))}
                    />
                  </label>
                  <div className="gt-row gt-row--end">
                    <button className="gt-btn gt-btn--sm" type="button" onClick={() => setEditingId("")}>
                      取消
                    </button>
                    <button className="gt-btn gt-btn--sm gt-btn--primary" type="submit" disabled={busy !== ""}>
                      {busy === "update" ? "保存中…" : "保存"}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="gt-row gt-row--between">
                    <span className="gt-small" style={{ fontWeight: 700 }}>
                      {draft.title || "（无标题）"}
                    </span>
                    <span className="gt-tag gt-tag--yellow">{draft.category}</span>
                  </div>
                  <p className="gt-body gt-muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {draft.content.length > 100 ? `${draft.content.slice(0, 100)}…` : draft.content || "（无正文）"}
                  </p>
                  <div className="gt-row gt-row--end">
                    <button className="gt-btn gt-btn--sm" type="button" onClick={() => startEdit(draft)} disabled={busy !== ""}>
                      编辑
                    </button>
                    <button
                      className="gt-btn gt-btn--sm gt-btn--danger"
                      type="button"
                      onClick={() => void onDelete(draft.id)}
                      disabled={busy !== ""}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
