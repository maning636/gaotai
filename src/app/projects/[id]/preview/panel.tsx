"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { renderTemplatePreview } from "../../../../lib/markdown";
import type { LayoutTemplate } from "../../../../lib/layout-template";
import { PREVIEW_SAMPLE } from "../../../../lib/preview-sample";
import { PhonePreview } from "../../../templates/phone-preview";
import styles from "./preview.module.css";

/**
 * 排版预览面板。
 *
 * 文章签字确认后，所有排版相关的操作都收在这里：
 * 选模板、看这篇稿子排出来的效果、复制排版正文、推到草稿箱。
 * 编辑器底部不再堆一长排按钮。
 *
 * 布局跟模板库一致（左卡片、右手机），区别是手机里渲染的是**真实正文**
 * （props.articleContent），不是示例稿——用户看到的就是「这一篇」排出来的样子。
 */

const SOURCE_LABEL: Record<LayoutTemplate["source"], string> = {
  builtin: "内置",
  imported: "随包",
  custom: "我的",
};

/** 卡片徽标：随包模板按来源再细分一层（与模板库同一口径）。 */
function badgeOf(template: LayoutTemplate): string {
  if (template.source === "custom") return SOURCE_LABEL.custom;
  if (template.id.startsWith("builtin:wedraft-")) return "WeDraft";
  if (template.id.startsWith("builtin:rico-")) return "rico";
  return SOURCE_LABEL.builtin;
}

/** 公众号通道检查结果（与 /api/wechat/test 返回一致）。 */
type ChannelCheck = {
  ok: boolean;
  reason: string;
  hint: string;
};

type CoverState = {
  configured: boolean;
};

type PreviewPanelProps = {
  projectId: string;
  projectTitle: string;
  topicName: string;
  /** 服务端读出来的正文（已保存的那一份）。 */
  articleContent: string;
  articleStatus: "draft" | "confirmed" | "empty";
  /** 这篇稿子记住的模板 id；没存过就回退到内置配色。 */
  initialTemplateId: string;
};

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
  const [busy, setBusy] = useState<"" | "copy" | "draft" | "apply" | "test">("");
  /** 通道检查结果。没测过就是 null；null 与 !ok 都要拦推草稿。 */
  const [channel, setChannel] = useState<ChannelCheck | null>(null);
  const [cover, setCover] = useState<CoverState>({ configured: false });

  // 拉模板清单，并保证选中项存在：记着的那套被删了就回退到第一套。
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

  // 进页面先把通道和封面状态读出来，顶部标签直接给出「能不能推」的答案。
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
      const body = (await response.json()) as CoverState;
      setCover({ configured: Boolean(body.configured) });
    } catch {
      // 封面状态读不到就不显示为已配，别误导用户去推。
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

  /**
   * 卡片的缩略图：把示例稿按该模板渲染成整段 HTML。
   * 跟模板库一致——卡片放的是「一眼可辨的排版长相」，手机里才看真实正文。
   */
  function renderCardPreview(template: LayoutTemplate): string {
    try {
      return renderTemplatePreview(PREVIEW_SAMPLE, template);
    } catch {
      return "";
    }
  }

  /** 点卡片：切换右侧手机，并把这套记成这篇稿子的偏好。 */
  async function onPick(template: LayoutTemplate) {
    if (busy) return;
    setSelectedId(template.id);
    setError("");
    setNotice("");
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

  /** 复制排版正文：剪贴板里同时写 html（带行内样式）和纯文本两份。 */
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

      // 先写纯文本作为兜底，html 那份用 ClipboardItem 单独写。
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
          // 忽略：纯文本那份已经复制成功了。
        }
      }
      setNotice("排版正文已复制（html + 纯文本两种格式）。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "复制失败，请手动选中复制。");
    } finally {
      setBusy("");
    }
  }

  /** 推到草稿箱：通道没通或封面没配都不给推。 */
  async function onPushDraft() {
    if (busy) return;
    if (!selected) return;
    if (!hasArticle) {
      setError("这篇稿子还没有正文，先回编辑器把文章正文走完。");
      return;
    }
    // 「先测后发」：推之前再测一次通道，测不通就把原因摆出来。
    const check = await checkChannel();
    if (!check?.ok) {
      setError(`公众号通道还没测通：${check?.reason ?? "还没测过"}。${check?.hint ?? "先测通道，测通了才能推。"}`);
      return;
    }
    if (!cover.configured) {
      setError("还没有封面图。公众号草稿必须带封面，请先到「公众号」页面上传一张。");
      return;
    }
    setBusy("draft");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/wechat/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, templateId: selected.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "推送失败。");
      const uploaded = Number(body.uploadedImages ?? 0);
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
    <div className="gt-stack gt-stack--lg">
      {/* 状态行：稿件信息 + 通道/封面标签 + 模板管理入口 */}
      <div className="gt-row gt-row--between" style={{ gap: "12px", flexWrap: "wrap" }}>
        <div className="gt-row" style={{ gap: "8px", flexWrap: "wrap" }}>
          <span className={`gt-tag ${articleStatus === "confirmed" ? "gt-tag--green" : articleStatus === "draft" ? "gt-tag--yellow" : "gt-tag--yellow"}`}>
            {statusLabel}
          </span>
          <span className="gt-tag" title={topicName}>专题：{topicName}</span>
          <span
            className={`gt-tag ${
              channel === null ? "gt-tag--yellow" : channel.ok ? "gt-tag--green" : "gt-tag--pink"
            }`}
            title={channel ? `${channel.reason}${channel.hint ? " " + channel.hint : ""}` : "还没测过通道"}
          >
            {channel === null ? "通道未测" : channel.ok ? "通道已通" : "通道不通"}
          </span>
          <span className={`gt-tag ${cover.configured ? "gt-tag--green" : "gt-tag--yellow"}`}>
            {cover.configured ? "封面已配" : "封面未配"}
          </span>
          {channel && !channel.ok ? (
            <button className="gt-btn gt-btn--sm" type="button" onClick={() => void checkChannel()} disabled={busy !== ""}>
              {busy === "test" ? "测试中…" : "重新测通道"}
            </button>
          ) : null}
        </div>
        <Link className="gt-btn gt-btn--sm gt-btn--ghost" href="/templates?tab=manage">
          模板管理
        </Link>
      </div>

      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}
      {!hasArticle ? (
        <div className="gt-alert gt-alert--warn">
          这篇稿子还没有正文。先回编辑器把「文章正文」这一步走完，再回来排版。
        </div>
      ) : null}

      <div className={styles.layout}>
        {/* 左：模板卡片 */}
        <div className={styles.gridWrap}>
          <p className={styles.hint}>
            挑一套排版：卡片里是这套模板的「长相」，右侧手机里是这篇稿子的真实正文。
            点卡片会把这套记成这篇稿子的排版偏好，下次打开还是它。
          </p>
          {loading ? (
            <div className="gt-empty">
              <span className="gt-empty__mark">⋯</span>
              模板清单读取中…
            </div>
          ) : templates.length === 0 ? (
            <div className="gt-empty">
              <span className="gt-empty__mark">?</span>
              还没有模板。去「模板管理」导入一套样式包，或者先用内置配色。
            </div>
          ) : (
            <div className={styles.grid} role="list">
              {templates.map(template => {
                const isPicked = selectedId === template.id;
                return (
                  <article
                    key={template.id}
                    className={`${styles.card}${isPicked ? " " + styles.cardPicked : ""}`}
                    role="listitem"
                    aria-pressed={isPicked ? "true" : "false"}
                  >
                    <div className={styles.cardHead}>
                      <h3 className={styles.cardTitle}>{template.name}</h3>
                      <span className={styles.badge}>{badgeOf(template)}</span>
                    </div>
                    <p className={styles.cardDesc}>{template.description || "（无描述）"}</p>
                    <div className={styles.cardThumb}>
                      <div
                        className={styles.thumbInner}
                        dangerouslySetInnerHTML={{ __html: renderCardPreview(template) }}
                      />
                    </div>
                    <div className={styles.cardFoot}>
                      <button
                        type="button"
                        className={`${styles.pickBtn}${isPicked ? " " + styles.pickBtnActive : ""}`}
                        onClick={() => void onPick(template)}
                        disabled={busy !== ""}
                      >
                        {isPicked ? (busy === "apply" ? "应用中…" : "当前这套") : "用这套"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {/* 右：手机预览（真实正文）+ 底部操作 */}
        <aside className={styles.previewCol}>
          <PhonePreview
            template={selected}
            content={articleContent}
            projectTitle={projectTitle}
            projectId={projectId}
            showApply={false}
          />
          <div className={styles.actions}>
            <div className={styles.actionsTarget}>
              <span className="gt-small gt-muted">当前模板</span>
              <span className={styles.actionsTargetName}>{selected?.name ?? "未选"}</span>
            </div>
            <div className="gt-row" style={{ gap: "8px", flexWrap: "wrap" }}>
              <button
                className="gt-btn gt-btn--sm"
                type="button"
                onClick={() => void onCopyFormatted()}
                disabled={busy !== "" || !selected}
              >
                {busy === "copy" ? "复制中…" : "复制排版正文"}
              </button>
              <button
                className="gt-btn gt-btn--sm gt-btn--primary"
                type="button"
                onClick={() => void onPushDraft()}
                disabled={busy !== "" || !selected}
              >
                {busy === "draft" ? "推送中…" : "推到草稿箱"}
              </button>
            </div>
          </div>
          <p className={styles.actionsHint}>
            「推到草稿箱」需要公众号通道已通、封面已配好（到「公众号」页面设置）。
            复制排版正文则不需要——贴进公众号编辑器即可。
          </p>
        </aside>
      </div>
    </div>
  );
}
