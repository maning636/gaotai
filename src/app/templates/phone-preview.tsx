"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { renderTemplatePreview } from "../../lib/markdown";
import type { LayoutTemplate } from "../../lib/layout-template";
import { inlineCustomCss } from "../../lib/custom-css/inliner";
import { PREVIEW_SAMPLE } from "../../lib/preview-sample";
import styles from "./templates.module.css";

/**
 * 手机预览：iPhone 外框 + 微信顶栏 + 底部「使用这套」。
 *
 * 尺寸参照 WeDraft 的 fixed-device.iphone：
 *   外框 456×972、边框 8px、圆角 62px，屏幕 440×956。
 * 按容器高度 fit 缩放：ResizeObserver 量容器尺寸，算出 scale，
 * 用 transform: scale() 缩小整台手机——这样状态栏、顶栏、正文都一致缩小，
 * 不会只缩正文导致微信外壳的比例破掉。
 *
 * 「使用这套」走编辑器里换模板用的**同一个**偏好接口（POST /api/wechat/theme），
 * 只是多一步 router.push 跳回编辑器。跳过去后编辑器会按新偏好重新拉一次预览。
 */

type PhonePreviewProps = {
  template: LayoutTemplate | undefined;
  /** 稿件标题：显示在顶栏右侧，让用户知道「这套要应用到哪」。 */
  projectTitle?: string;
  /** 稿件 id：有值才允许点「使用这套」。 */
  projectId?: string;
  /**
   * 是否显示底部「使用这套」操作条。
   * 模板管理里手机只负责看效果，点「使用」没有意义，传 false 隐藏。
   */
  showApply?: boolean;
  /** 覆盖手机自适应框的高度（模板管理里要在视口内放下整台手机）。 */
  fitHeight?: string;
  /**
   * 手机里渲染的正文（Markdown）。
   *
   * 模板库用它默认的示例稿；排版预览页传这篇稿子的**真实正文**，
   * 让用户看的是「这一篇排出来长什么样」，而不是示例稿。
   */
  content?: string;
  /**
   * 自定义 CSS：粘贴后内联到预览里。仅影响预览，不写入稿件。
   * 排版预览页传用户粘贴的 CSS；模板库不传。
   */
  customCss?: string;
  /** 是否允许拖拽图片到手机屏幕。 */
  droppable?: boolean;
  /** 拖拽悬停时高亮提示（父组件控制状态）。 */
  dragOver?: boolean;
  /** 通知父组件拖拽悬停状态变化。 */
  onDragOverChange?: (over: boolean) => void;
  /** 从素材库拖入图片 URL 时回调（dropIndex = 段落索引，插到该段落后）。 */
  onDropImage?: (url: string, dropIndex?: number) => void;
  /** 从本机拖入文件时回调（dropIndex 同上）。 */
  onDropFiles?: (files: File[], dropIndex?: number) => void;
};

type ApplyState = "idle" | "saving" | "done";

const PHONE_W = 456;
const PHONE_H = 972;

export function PhonePreview({ template, projectTitle, projectId, showApply = true, fitHeight, content, customCss, droppable, dragOver, onDragOverChange, onDropImage, onDropFiles }: PhonePreviewProps) {
  const router = useRouter();
  const fitRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.62);
  const [applyState, setApplyState] = useState<ApplyState>("idle");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  /** 防止 drop 事件在短时间内重复触发。 */
  const lastDropRef = useRef(0);

  /**
   * 按容器尺寸算出缩放系数。
   *
   * 手机是 456×972 的固定比例；fit 取宽和高里的较小值，
   * 让整台手机在任何容器里都完整可见。
   * fitRef 直接量「装手机的框」，不量外层的 previewCol——
   * 后者还要给底部按钮留出空间。
   */
  useLayoutEffect(() => {
    const node = fitRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const next = Math.min(rect.width / PHONE_W, rect.height / PHONE_H);
      setScale(next > 0 ? Math.min(1, next) : 0.62);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /**
   * 屏幕内的正文渲染。
   *
   * 换模板就重算一次；渲染是纯函数（拿模板 + 正文），
   * 不需要走后端——真正的稿件要推到草稿时才走 /api/wechat/preview。
   * 排版预览页传了 content（真实正文）就用它，模板库没传就用示例稿。
   */
  const previewHtml = useMemo(() => {
    if (!template) return "";
    try {
      const html = renderTemplatePreview(content ?? PREVIEW_SAMPLE, template);
      if (customCss && customCss.trim()) {
        // 自定义 CSS 内联到预览；fail-open，失败时原样返回。
        return inlineCustomCss(html, customCss, { rootSelector: ".gt-article-root" });
      }
      return html;
    } catch {
      return "";
    }
  }, [template, content, customCss]);

  async function onApply() {
    if (!template || !projectId || applyState === "saving") return;
    setApplyState("saving");
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/wechat/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, templateId: template.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "应用模板失败。");
      setApplyState("done");
      setNotice(`已把「${template.name}」应用到这篇稿子。`);
      // 短暂停一下让用户看到「已应用」的状态，然后跳回编辑器。
      setTimeout(() => {
        router.push(`/projects/${encodeURIComponent(projectId)}`);
      }, 350);
    } catch (issue) {
      setApplyState("idle");
      setError(issue instanceof Error ? issue.message : "应用模板失败。");
    }
  }

  const canApply = Boolean(template && projectId && applyState !== "saving");

  return (
    <div className={styles.phoneCol}>
      <div className={styles.phoneFit} ref={fitRef} style={fitHeight ? { height: fitHeight } : undefined}>
        <div
          className={styles.phoneWrap}
          style={{ width: PHONE_W, height: PHONE_H, transform: `scale(${scale})` }}
        >
          <div className={styles.phone}>
            {/* 状态栏：9:41 + 灵动岛 + 信号/WiFi/电池 */}
            <div className={styles.statusBar} aria-hidden="true">
              <span className={styles.statusTime}>9:41</span>
              <span className={styles.statusIsland} />
              <span className={styles.statusIcons}>
                <svg width="18" height="11" viewBox="0 0 18 11" fill="currentColor">
                  <rect x="0" y="7" width="3" height="4" rx="0.5" />
                  <rect x="4" y="5" width="3" height="6" rx="0.5" />
                  <rect x="8" y="2.5" width="3" height="8.5" rx="0.5" />
                  <rect x="12" y="0" width="3" height="11" rx="0.5" />
                </svg>
                <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor">
                  <path d="M8 9.2 a1.2 1.2 0 1 0 0.001 0 z" />
                  <path d="M4.8 7.2 c1.1 -1.2 5.3 -1.2 6.4 0" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
                  <path d="M2.4 4.8 c2.5 -2.7 8.7 -2.7 11.2 0" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
                </svg>
                <span className={styles.battery}>
                  <span className={styles.batteryInner} />
                  <span className={styles.batteryCap} />
                </span>
              </span>
            </div>

            {/* 微信顶栏：返回箭头 + 「公众号」+ 更多 */}
            <div className={styles.wechatBar} aria-hidden="true">
              <svg className={styles.wechatBack} width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="8,1 2,8 8,15" />
              </svg>
              <strong>公众号</strong>
              <svg width="14" height="4" viewBox="0 0 14 4" fill="currentColor">
                <circle cx="1" cy="2" r="1.3" />
                <circle cx="7" cy="2" r="1.3" />
                <circle cx="13" cy="2" r="1.3" />
              </svg>
            </div>

            {/* 屏幕内容：滚动展示渲染结果（droppable 时可接收拖拽图片） */}
            <div
              className={`${styles.phoneScreen}${droppable && dragOver ? " " + styles.phoneScreenDrop : ""}`}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
              onDragOver={droppable ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                if (!dragOver) onDragOverChange?.(true);
              } : undefined}
              onDragLeave={droppable ? (e) => {
                // 只在真正离开 phoneScreen 时才清除（不是进入子元素时）
                if (e.currentTarget === e.target) onDragOverChange?.(false);
              } : undefined}
              onDrop={droppable ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onDragOverChange?.(false);

                // 防重复：用时间戳去重，300ms 内只处理一次 drop
                const now = Date.now();
                if (now - lastDropRef.current < 300) return;
                lastDropRef.current = now;

                // 算出 drop 位置对应的段落索引
                const screen = e.currentTarget as HTMLElement;
                const blockElements = Array.from(screen.children);
                let dropIndex: number | undefined;

                if (blockElements.length > 0) {
                  // 找 drop target 最近的顶层块级子元素
                  let target = e.target as HTMLElement | null;
                    while (target && target.parentElement !== screen) {
                    target = target.parentElement;
                  }
                  if (target) {
                    const idx = blockElements.indexOf(target);
                    if (idx >= 0) dropIndex = idx;
                  }
                }

                // 优先从素材库拖出（自定义 dataTransfer）
                const url = e.dataTransfer.getData("text/x-gaotai-image");
                if (url) { onDropImage?.(url, dropIndex); return; }
                // 从本机拖文件
                if (e.dataTransfer.files.length > 0) {
                  onDropFiles?.(Array.from(e.dataTransfer.files), dropIndex);
                }
              } : undefined}
            />
          </div>
        </div>
      </div>

      {showApply ? (
      <div className={styles.phoneActions}>
        {projectTitle ? (
          <span className={styles.applyTarget}>
            <span className="gt-small gt-muted">将应用到</span>
            <span className={styles.applyTargetName}>《{projectTitle}》</span>
          </span>
        ) : (
          <span className="gt-small gt-muted">从稿件页进入可应用</span>
        )}
        <button
          type="button"
          className="gt-btn gt-btn--primary gt-btn--sm"
          disabled={!canApply}
          onClick={() => {
            void onApply();
          }}
        >
          {applyState === "saving" ? "应用中…" : "使用这套"}
        </button>
      </div>
      ) : null}

      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}
    </div>
  );
}
