"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { renderTemplatePreview } from "../../../../lib/markdown";
import type { LayoutTemplate } from "../../../../lib/layout-template";
import { PREVIEW_SAMPLE } from "../../../../lib/preview-sample";
import { PhonePreview } from "../../../templates/phone-preview";
import styles from "./preview.module.css";

/**
 * 排版预览面板（发布中心）。
 *
 * 文章签字确认后，所有排版到发布的操作按顺序收在这一页：
 *   ① 选模板 → ② 插入图表（含配图提示词）→ ③ 公众号通道 → ④ 封面图 → ⑤ 推草稿
 * 左侧功能区从上到下就是这条流程，右侧手机常驻显示真实正文。
 *
 * 用户不用在导航栏来回跳——通道没通就提示去配，封面没配就提示去配，
 * 都就绪了「推到草稿箱」才能点；推完了出现「去公众号后台发布」。
 */

const SOURCE_LABEL: Record<LayoutTemplate["source"], string> = {
  builtin: "内置",
  imported: "随包",
  custom: "我的",
};

function badgeOf(template: LayoutTemplate): string {
  if (template.source === "custom") return SOURCE_LABEL.custom;
  if (template.id.startsWith("builtin:wedraft-")) return "WeDraft";
  if (template.id.startsWith("builtin:rico-")) return "rico";
  return SOURCE_LABEL.builtin;
}

type ChannelCheck = {
  ok: boolean;
  reason: string;
  hint: string;
};

type CoverState = {
  configured: boolean;
  image: string;
  previewUrl: string;
};

type PreviewPanelProps = {
  projectId: string;
  projectTitle: string;
  topicName: string;
  articleContent: string;
  articleStatus: "draft" | "confirmed" | "empty";
  initialTemplateId: string;
};

/** 推草稿是否成功——成功后显示「去发布」入口。 */
type DraftResult = { ok: true; title: string; uploadedImages: number } | null;

export function PreviewPanel({
  projectId,
  projectTitle,
  topicName,
  articleContent,
  articleStatus,
  initialTemplateId,
}: PreviewPanelProps) {
  const [templates, setTemplates] = useState<LayoutTemplate[]>([]);
  const [selectedId, setSelectedId] = useState(initialTemplateId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"" | "copy" | "draft" | "apply" | "test" | "prompt">("");
  const [channel, setChannel] = useState<ChannelCheck | null>(null);
  const [cover, setCover] = useState<CoverState>({ configured: false, image: "", previewUrl: "" });
  const [draftResult, setDraftResult] = useState<DraftResult>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/layout-templates", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("读取模板失败"))))
      .then((body: { templates?: LayoutTemplate[] }) => {
        if (!alive) return;
        const list = Array.isArray(body.templates) ? body.templates : [];
        setTemplates(list);
        setSelectedId(prev => {
          if (list.some(item => item.id === prev)) return prev;
          return list[0]?.id ?? "";
        });
      })
      .catch(() => {
        if (alive) setTemplates([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const checkChannel = useCallback(async () => {
    setBusy("test");
    setError("");
    try {
      const response = await fetch("/api/wechat/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as ChannelCheck;
      setChannel(body);
      return body;
    } catch {
      setChannel({ ok: false, reason: "通道检查失败", hint: "稍后再试一次。" });
      return null;
    } finally {
      setBusy("");
    }
  }, []);

  const checkCover = useCallback(async () => {
    try {
      const response = await fetch("/api/wechat/cover", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      setCover({
        configured: Boolean(body.configured),
        image: body.image ?? "",
        previewUrl: body.previewUrl ?? "",
      });
    } catch {
      // 读不到就不显示已配
    }
  }, []);

  useEffect(() => {
    void checkChannel();
    void checkCover();
  }, [checkChannel, checkCover]);

  const selected = useMemo(
    () => templates.find(item => item.id === selectedId),
    [templates, selectedId],
  );

  const hasArticle = articleContent.trim().length > 0;
  const channelReady = channel?.ok ?? false;
  const coverReady = cover.configured;
  const draftReady = hasArticle && channelReady && coverReady;

  function renderCardPreview(template: LayoutTemplate): string {
    try {
      return renderTemplatePreview(PREVIEW_SAMPLE, template);
    } catch {
      return "";
    }
  }

  async function onPick(template: LayoutTemplate) {
    if (busy) return;
    setSelectedId(template.id);
    setError("");
    setNotice("");
    setDraftResult(null);
    setBusy("apply");
    try {
      const response = await fetch("/api/wechat/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, templateId: template.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "应用模板失败。");
      setNotice(`已把「${template.name}」应用到这篇稿子。`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "应用模板失败。");
    } finally {
      setBusy("");
    }
  }

  async function onImagePrompt() {
    if (busy) return;
    if (!hasArticle) {
      setError("这篇稿子还没有正文，先回编辑器把文章正文走完。");
      return;
    }
    setBusy("prompt");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/image-prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: projectTitle, article: articleContent }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "生成配图提示词失败。");
      setNotice(`配图提示词：${body.prompt}`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "生成配图提示词失败。");
    } finally {
      setBusy("");
    }
  }

  async function onCopyFormatted() {
    if (busy) return;
    if (!selected) return;
    if (!hasArticle) {
      setError("这篇稿子还没有正文，先回编辑器把文章正文走完。");
      return;
    }
    setBusy("copy");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/wechat/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, templateId: selected.id, content: articleContent }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "预览失败。");
      const html = String(body.html ?? "");
      const text = String(body.text ?? "");
      if (!html) throw new Error("这篇稿子还没有正文。");
      await navigator.clipboard.writeText(text);
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([html], { type: "text/html" }),
              "text/plain": new Blob([text], { type: "text/plain" }),
            }),
          ]);
        } catch {
          // 纯文本已经够了
        }
      }
      setNotice("排版正文已复制（html + 纯文本两种格式）。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "复制失败。");
    } finally {
      setBusy("");
    }
  }

  async function onPushDraft() {
    if (busy) return;
    if (!selected) return;
    if (!hasArticle) {
      setError("这篇稿子还没有正文，先回编辑器把文章正文走完。");
      return;
    }
    const check = await checkChannel();
    if (!check?.ok) {
      setError(`公众号通道还没测通：${check?.reason ?? "还没测过"}。${check?.hint ?? ""}`);
      return;
    }
    if (!cover.configured) {
      setError("还没有封面图。公众号草稿必须带封面，请先到「公众号」页面设一张。");
      return;
    }
    setBusy("draft");
    setError("");
    setNotice("");
    setDraftResult(null);
    try {
      const response = await fetch("/api/wechat/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, templateId: selected.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "推送失败。");
      const uploaded = Number(body.uploadedImages ?? 0);
      setDraftResult({ ok: true, title: body.title, uploadedImages: uploaded });
      setNotice(
        [`已放进草稿箱：${body.title}`, uploaded > 0 ? `正文图片已上传 ${uploaded} 张到微信。` : ""]
          .filter(Boolean)
          .join(""),
      );
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "推送失败。");
    } finally {
      setBusy("");
    }
  }

  const statusLabel =
    articleStatus === "confirmed" ? "正文已签字" : articleStatus === "draft" ? "正文草稿" : "正文未开始";

  return (
    <div className={styles.layout}>
      {/* ============ 左侧：功能区（从上到下按操作顺序） ============ */}
      <div className={styles.gridWrap}>
        {/* 顶部稿件信息条 */}
        <div className={styles.infoBar}>
          <Link className="gt-btn gt-btn--sm gt-btn--ghost" href={`/projects/${projectId}`}>
            ← 返回编辑器
          </Link>
          <span className={`gt-tag ${articleStatus === "confirmed" ? "gt-tag--green" : "gt-tag--yellow"}`}>
            {statusLabel}
          </span>
          <span className="gt-small gt-muted" title={topicName}>{projectTitle}</span>
        </div>

        {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
        {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}
        {!hasArticle ? (
          <div className="gt-alert gt-alert--warn">
            这篇稿子还没有正文。先回编辑器把「文章正文」走完，再回来排版。
          </div>
        ) : null}

        {/* ① 选模板 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>1</span>
            <h2 className={styles.stepTitle}>选排版模板</h2>
            <Link className="gt-small" href="/templates?tab=manage" style={{ marginLeft: "auto" }}>
              模板管理 →
            </Link>
          </div>
          {loading ? (
            <div className="gt-empty">
              <span className="gt-empty__mark">⋯</span>
              模板清单读取中…
            </div>
          ) : templates.length === 0 ? (
            <div className="gt-empty">
              <span className="gt-empty__mark">?</span>
              还没有模板。去「模板管理」导入一套样式包。
            </div>
          ) : (
            <div className={styles.templateList}>
              {templates.map(template => {
                const isPicked = selectedId === template.id;
                return (
                  <button
                    key={template.id}
                    type="button"
                    className={`${styles.templateItem}${isPicked ? " " + styles.templateItemActive : ""}`}
                    onClick={() => void onPick(template)}
                    disabled={busy !== ""}
                  >
                    <div className={styles.templateThumb}>
                      <div
                        className={styles.thumbInner}
                        dangerouslySetInnerHTML={{ __html: renderCardPreview(template) }}
                      />
                    </div>
                    <div className={styles.templateInfo}>
                      <div className={styles.templateNameRow}>
                        <span className={styles.templateName}>{template.name}</span>
                        <span className={styles.badge}>{badgeOf(template)}</span>
                      </div>
                      <span className={styles.templateDesc}>
                        {template.description || "（无描述）"}
                      </span>
                    </div>
                    <span className={styles.templateStatus}>
                      {isPicked ? (busy === "apply" ? "…" : "✓") : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* ② 插入图表 + 配图提示词 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>2</span>
            <h2 className={styles.stepTitle}>插入图表</h2>
          </div>
          <p className={styles.stepDesc}>
            在编辑器里插入图片和图表后，回到这里排版。图表会随正文一起推到公众号草稿。
          </p>
          <div className={styles.stepBlock}>
            <div className="gt-row" style={{ gap: "8px", flexWrap: "wrap" }}>
              <Link className="gt-btn gt-btn--sm gt-btn--ghost" href={`/projects/${projectId}`}>
                插入图片 →
              </Link>
              <Link className="gt-btn gt-btn--sm gt-btn--ghost" href={`/projects/${projectId}`}>
                生成图解 →
              </Link>
              <button
                className="gt-btn gt-btn--sm gt-btn--ghost"
                type="button"
                onClick={() => void onImagePrompt()}
                disabled={busy !== ""}
              >
                {busy === "prompt" ? "生成中…" : "配图提示词"}
              </button>
            </div>
          </div>
        </section>

        {/* ③ 公众号通道 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>3</span>
            <h2 className={styles.stepTitle}>公众号通道</h2>
            <span
              className={`gt-tag ${channel === null ? "gt-tag--yellow" : channel.ok ? "gt-tag--green" : "gt-tag--pink"}`}
              style={{ marginLeft: "auto" }}
            >
              {channel === null ? "未测" : channel.ok ? "已通" : "不通"}
            </span>
          </div>
          {channel && channel.ok ? (
            <p className={styles.stepDesc}>通道正常，可以推草稿。</p>
          ) : channel && !channel.ok ? (
            <div className={styles.stepBlock}>
              <p className={styles.stepDesc}>
                {channel.reason}。{channel.hint}
              </p>
              <div className="gt-row" style={{ gap: "8px" }}>
                <button className="gt-btn gt-btn--sm" type="button" onClick={() => void checkChannel()} disabled={busy !== ""}>
                  {busy === "test" ? "测试中…" : "重新测试"}
                </button>
                <Link className="gt-btn gt-btn--sm gt-btn--ghost" href="/wechat">
                  去配公众号凭据 →
                </Link>
              </div>
            </div>
          ) : (
            <div className={styles.stepBlock}>
              <p className={styles.stepDesc}>还没测过通道，先测一次。</p>
              <button className="gt-btn gt-btn--sm" type="button" onClick={() => void checkChannel()} disabled={busy !== ""}>
                {busy === "test" ? "测试中…" : "测试通道"}
              </button>
            </div>
          )}
        </section>

        {/* ④ 封面图 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>4</span>
            <h2 className={styles.stepTitle}>封面图</h2>
            <span className={`gt-tag ${coverReady ? "gt-tag--green" : "gt-tag--yellow"}`} style={{ marginLeft: "auto" }}>
              {coverReady ? "已配" : "未配"}
            </span>
          </div>
          {coverReady && cover.previewUrl ? (
            <div className={styles.stepBlock}>
              <img
                src={cover.previewUrl}
                alt="当前封面"
                className={styles.coverPreview}
              />
              <Link className="gt-btn gt-btn--sm gt-btn--ghost" href="/wechat">
                去公众号页换封面 →
              </Link>
            </div>
          ) : (
            <div className={styles.stepBlock}>
              <p className={styles.stepDesc}>
                公众号草稿必须带封面。去公众号页面上传一张。
              </p>
              <Link className="gt-btn gt-btn--sm gt-btn--ghost" href="/wechat">
                去配封面 →
              </Link>
            </div>
          )}
        </section>

        {/* ⑤ 推草稿箱 */}
        <section className={`${styles.step} ${styles.stepFinal}`}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>5</span>
            <h2 className={styles.stepTitle}>推到草稿箱</h2>
          </div>
          {draftResult ? (
            <div className={styles.stepBlock}>
              <div className="gt-alert gt-alert--ok" style={{ marginBottom: "8px" }}>
                已放进草稿箱：{draftResult.title}
                {draftResult.uploadedImages > 0
                  ? `（正文图片已上传 ${draftResult.uploadedImages} 张）`
                  : ""}
              </div>
              <p className={styles.stepDesc}>
                去公众号后台预览、编辑、发布。稿台不代替人点发布。
              </p>
              <div className={styles.draftActions}>
                <a
                  className="gt-btn gt-btn--primary gt-btn--block"
                  href="https://mp.weixin.qq.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  去公众号后台发布 →
                </a>
                <button
                  className="gt-btn gt-btn--block draftCopyBtn"
                  type="button"
                  onClick={() => void onCopyFormatted()}
                  disabled={busy !== ""}
                >
                  {busy === "copy" ? "复制中…" : "复制排版正文"}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.stepBlock}>
              <p className={styles.stepDesc}>
                {draftReady
                  ? "一切就绪，可以推了。"
                  : hasArticle
                    ? channelReady
                      ? coverReady
                        ? "就绪。"
                        : "还差封面图——上面第 4 步。"
                      : "通道还没通——上面第 3 步。"
                    : "还没有正文——先回编辑器写完。"}
              </p>
              <div className={styles.draftActions}>
                <button
                  className="gt-btn gt-btn--primary draftPushBtn"
                  type="button"
                  onClick={() => void onPushDraft()}
                  disabled={busy !== "" || !draftReady}
                >
                  {busy === "draft" ? "推送中…" : "推到草稿箱 →"}
                </button>
                <button
                  className="gt-btn draftCopyBtn"
                  type="button"
                  onClick={() => void onCopyFormatted()}
                  disabled={busy !== "" || !selected}
                >
                  {busy === "copy" ? "复制中…" : "复制排版正文"}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ============ 右侧：手机预览（常驻） ============ */}
      <aside className={styles.previewCol}>
        <PhonePreview
          template={selected}
          content={articleContent}
          projectTitle={projectTitle}
          projectId={projectId}
          showApply={false}
        />
      </aside>
    </div>
  );
}
