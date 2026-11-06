"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { THEMES, getCardTheme, type CardTheme, type CardTypography } from "../../../../lib/card-themes";
import {
  DEFAULT_RATIO,
  RATIO_KEYS,
  RATIO_PRESETS,
  pageSizeForRatio,
  buildBlocksFromMarkdown,
  createCardPagePlan,
  availableContentHeight,
} from "../../../../lib/card/render-engine";
import {
  createCardPageElement,
  injectCardCss,
  removeInjectedCardCss,
  measurePageOverflow,
} from "../../../../lib/card/assembly";
import {
  createOffscreenContainer,
  removeOffscreenContainer,
} from "../../../../lib/card/offscreen";
import { exportCards, exportedSuccessCount, exportedFailCount } from "../../../../lib/card/exporter";
import { capturePageToDataUrl } from "../../../../lib/card/capture";
import { buildCoverModel } from "../../../../lib/card/cover-model";
import { extractTitle } from "../../../../lib/markdown";
import styles from "./cards.module.css";

/**
 * 知识卡片模式面板。
 *
 * 左：主题选择（17 套方块网格）、比例（3:4/3:5/9:16）、排版 Token 调整、封面选图。
 * 右：多页卡片实时预览（纵向缩略图），可点开放大。
 * 底：单张复制到剪贴板、批量导出 PNG 到文件夹。
 *
 * 分页流程：估算切页 → 离屏实测 → 溢出重排（最多 3 轮）→ 生成真实 DOM 存入 state。
 * 缩略图用 scaled 克隆；截图/复制/放大都用离屏里的原始 DOM（布局准确）。
 */

type CardsPanelProps = {
  projectId: string;
  projectTitle: string;
  topicName: string;
  articleContent: string;
};

type CoverImage = {
  url: string;
  name: string;
};

/** 离屏容器准备完成信号：ref 存容器，state 仅作重渲染触发器。 */
type OffscreenReady = number;

export function CardsPanel({
  projectId,
  projectTitle,
  topicName,
  articleContent,
}: CardsPanelProps) {
  const [themeId, setThemeId] = useState<string>("simple-white");
  const [ratio, setRatio] = useState<string>(DEFAULT_RATIO);
  const [typography, setTypography] = useState<CardTypography>({});
  const [coverImage, setCoverImage] = useState<CoverImage | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState("");
  const [zoom, setZoom] = useState<{ index: number; url: string } | null>(null);
  /** 离屏容器是否已挂载（0 = 未就绪，>0 = 就绪）。 */
  const [offscreenReady, setOffscreenReady] = useState<OffscreenReady>(0);
  /** 当前页面元素列表（真实 DOM，供截图/复制/放大）。 */
  const [pageEls, setPageEls] = useState<HTMLDivElement[]>([]);

  const coverPicker = useRef<HTMLInputElement>(null);
  const thumbRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** 离屏容器本体（可变引用，不参与渲染）。 */
  const offscreenRef = useRef<HTMLDivElement | null>(null);

  const theme: CardTheme = useMemo(
    () => getCardTheme(themeId) ?? getCardTheme("simple-white")!,
    [themeId],
  );

  const blocks = useMemo(() => buildBlocksFromMarkdown(articleContent), [articleContent]);
  const title = useMemo(
    () => extractTitle(articleContent) || projectTitle,
    [articleContent, projectTitle],
  );

  const pageSize = useMemo(() => pageSizeForRatio(ratio), [ratio]);
  const contentH = useMemo(() => availableContentHeight(theme, pageSize), [theme, pageSize]);

  // 主题 CSS 注入（scoped）。切换主题/字号时重建。
  useEffect(() => {
    injectCardCss(theme, typography);
    return () => removeInjectedCardCss();
  }, [theme, typography]);

  // 建立离屏容器。
  useEffect(() => {
    const container = createOffscreenContainer();
    offscreenRef.current = container;
    setOffscreenReady(1);
    return () => removeOffscreenContainer(container);
  }, []);

  // 分页 + 溢出重排，生成真实 DOM 存入 state。
  useEffect(() => {
    const container = offscreenRef.current;
    if (!container || !offscreenReady) return;
    const gap = theme.tokens.contentGap;
    let plan = createCardPagePlan({ blocks, pageSize, contentHeight: contentH, gap });

    for (let round = 0; round < 3; round += 1) {
      const els = plan.pages.map(page =>
        createCardPageElement(page, { theme, typography, pageSize, watermark: projectTitle }),
      );
      container.innerHTML = "";
      els.forEach(el => container.appendChild(el));

      const anyOverflow = els.some(el => measurePageOverflow(el));
      if (!anyOverflow) {
        setPageEls(els);
        return;
      }
      for (const page of plan.pages) {
        const host = container.querySelector<HTMLElement>(`[data-card-page="${page.index}"]`);
        const content = host?.querySelector<HTMLElement>(".icard-content");
        if (!content) continue;
        const children = Array.from(content.children);
        children.forEach((child, idx) => {
          const block = page.blocks[idx];
          if (block) block.estimate = Math.round(child.getBoundingClientRect().height);
        });
      }
      plan = createCardPagePlan({ blocks, pageSize, contentHeight: contentH, gap });
    }

    // 最后一轮：直接接受结果（哪怕仍有单块超高）。
    const els = plan.pages.map(page =>
      createCardPageElement(page, { theme, typography, pageSize, watermark: projectTitle }),
    );
    container.innerHTML = "";
    els.forEach(el => container.appendChild(el));
    setPageEls(els);
  }, [offscreenReady, blocks, theme, typography, pageSize, contentH, projectTitle]);

  const pageCount = pageEls.length;

  // 重绘缩略图：把 pageEls 克隆成 scaled 副本填入缩略图 host。
  useEffect(() => {
    const scale = Math.min(1, 170 / pageSize.w);
    const hostH = Math.round(170 * (pageSize.h / pageSize.w));
    thumbRefs.current.forEach((host, index) => {
      if (!host) return;
      const el = pageEls[index];
      host.innerHTML = "";
      if (el) {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.style.transform = `scale(${scale})`;
        clone.style.transformOrigin = "top left";
        clone.style.position = "absolute";
        clone.style.width = `${pageSize.w}px`;
        clone.style.height = `${pageSize.h}px`;
        host.appendChild(clone);
      }
    });
    // 用 hostH 设置容器高度（在 style 里已定，这里同步缩放用）。
    void hostH;
  }, [pageEls, pageSize]);

  // 单张复制到剪贴板。
  async function onCopyPage(index: number) {
    const el = pageEls[index];
    if (!el) return;
    setError("");
    try {
      const dataUrl = await capturePageToDataUrl(el, 2);
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setNotice(`已把第 ${index + 1} 张卡片复制到剪贴板。`);
    } catch {
      setError("复制失败：浏览器可能不支持写入剪贴板，改用「批量导出 PNG」。");
    }
  }

  // 批量导出 PNG。
  async function onExportAll() {
    if (exporting) return;
    if (pageEls.length === 0) {
      setError("还没有可导出的页面。");
      return;
    }
    setExporting(true);
    setError("");
    setNotice("");
    try {
      const results = await exportCards(pageEls, {
        scale: 2,
        onProgress: (i, total) => setProgress(`${i + 1}/${total}`),
      });
      const dataUrls = results.filter(item => item.url !== null).map(item => item.url as string);
      const ok = exportedSuccessCount(results);
      const fail = exportedFailCount(results);
      if (dataUrls.length === 0) {
        setError("导出失败：没有一页截到图。");
        return;
      }
      // eslint-disable-next-line no-control-regex
      const safeDir = projectTitle.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim() || "卡片";
      const response = await fetch("/api/card/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: dataUrls, dir: safeDir }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "写盘失败。");
      setNotice(`已导出 ${ok} 张 PNG${fail ? `，${fail} 张失败` : ""}。`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "导出失败。");
    } finally {
      setExporting(false);
      setProgress("");
    }
  }

  // 放大预览。
  async function onZoomPage(index: number) {
    const el = pageEls[index];
    if (!el) return;
    setError("");
    try {
      const dataUrl = await capturePageToDataUrl(el, 2);
      setZoom({ index, url: dataUrl });
    } catch {
      setError("放大预览失败。");
    }
  }

  function onCoverUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCoverImage({ url: String(reader.result ?? ""), name: file.name });
    };
    reader.readAsDataURL(file);
  }

  const coverModel = buildCoverModel({ title, topicName }, theme, ratio, coverImage?.url ?? "");

  return (
    <div className={styles.layout}>
      {/* ============ 左：配置面板 ============ */}
      <div className={styles.gridWrap}>
        <div className={styles.infoBar}>
          <Link className="gt-btn gt-btn--sm gt-btn--ghost" href={`/projects/${projectId}/preview`}>
            ← 返回排版预览
          </Link>
          <span className="gt-tag gt-tag--blue">知识卡片</span>
          <span className="gt-small gt-muted" title={projectTitle}>{projectTitle}</span>
        </div>

        {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
        {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

        {/* ① 主题 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>1</span>
            <h2 className={styles.stepTitle}>选主题</h2>
            <span className={styles.stepMeta}>{Object.keys(THEMES).length} 套</span>
          </div>
          <div className={styles.themeGrid}>
            {Object.values(THEMES).map(item => {
              const active = item.id === themeId;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.themeItem}${active ? " " + styles.themeItemActive : ""}`}
                  onClick={() => setThemeId(item.id)}
                  title={item.name}
                >
                  <span
                    className={styles.themeSwatch}
                    style={{ background: item.tokens.background, color: item.tokens.textColor }}
                  >
                    <span
                      className={styles.themeSwatchDot}
                      style={{ background: item.tokens.accentColor }}
                    />
                  </span>
                  <span className={styles.themeName}>{item.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ② 比例 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>2</span>
            <h2 className={styles.stepTitle}>比例</h2>
          </div>
          <div className={styles.ratioRow}>
            {RATIO_KEYS.map(key => {
              const preset = RATIO_PRESETS[key];
              const active = key === ratio;
              return (
                <button
                  key={key}
                  type="button"
                  className={`${styles.ratioItem}${active ? " " + styles.ratioItemActive : ""}`}
                  onClick={() => setRatio(key)}
                >
                  <span className={styles.ratioBox} style={{ aspectRatio: `${preset.w} / ${preset.h}` }}>
                    {key}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ③ 排版 Token */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>3</span>
            <h2 className={styles.stepTitle}>排版 Token</h2>
            <button
              type="button"
              className="gt-btn gt-btn--sm gt-btn--ghost"
              style={{ marginLeft: "auto" }}
              onClick={() => setTokenOpen(v => !v)}
            >
              {tokenOpen ? "收起" : "调整"}
            </button>
          </div>
          {tokenOpen ? (
            <div className={styles.tokenBlock}>
              <label className={styles.tokenRow}>
                <span className={styles.tokenLabel}>正文字号</span>
                <input
                  type="range"
                  min={12}
                  max={20}
                  value={typography.fontSize ?? 14}
                  onChange={e => setTypography(t => ({ ...t, fontSize: Number(e.target.value) }))}
                />
                <span className={styles.tokenValue}>{typography.fontSize ?? 14}px</span>
              </label>
              <label className={styles.tokenRow}>
                <span className={styles.tokenLabel}>行高</span>
                <input
                  type="range"
                  min={1.3}
                  max={2.2}
                  step={0.05}
                  value={typography.lineHeight ?? 1.7}
                  onChange={e => setTypography(t => ({ ...t, lineHeight: Number(e.target.value) }))}
                />
                <span className={styles.tokenValue}>{typography.lineHeight ?? 1.7}</span>
              </label>
              <label className={styles.tokenRow}>
                <span className={styles.tokenLabel}>内边距</span>
                <input
                  type="range"
                  min={16}
                  max={36}
                  value={typography.pagePadding ?? theme.tokens.pagePadding}
                  onChange={e => setTypography(t => ({ ...t, pagePadding: Number(e.target.value) }))}
                />
                <span className={styles.tokenValue}>
                  {typography.pagePadding ?? theme.tokens.pagePadding}px
                </span>
              </label>
            </div>
          ) : (
            <p className={styles.stepDesc}>可调整正文字号 / 行高 / 内边距。</p>
          )}
        </section>

        {/* ④ 封面选图 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>4</span>
            <h2 className={styles.stepTitle}>封面图</h2>
            <span className={`gt-tag ${coverImage ? "gt-tag--green" : "gt-tag--yellow"}`} style={{ marginLeft: "auto" }}>
              {coverImage ? "已选" : "未选"}
            </span>
          </div>
          {coverImage ? (
            <div className={styles.coverBlock}>
              <img src={coverImage.url} alt="封面预览" className={styles.coverPreview} />
              <button type="button" className="gt-btn gt-btn--sm gt-btn--ghost" onClick={() => setCoverImage(null)}>
                移除封面
              </button>
            </div>
          ) : (
            <div className={styles.coverBlock}>
              <p className={styles.stepDesc}>
                上传本地图片做封面（AI 生图 / Unsplash 接口预留）。封面底色
                {coverModel.background.startsWith("linear") ? "渐变" : "色"} · 比例 {coverModel.ratio}。
              </p>
              <input
                ref={coverPicker}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: "none" }}
                onChange={onCoverUpload}
              />
              <button type="button" className="gt-btn gt-btn--sm" onClick={() => coverPicker.current?.click()}>
                上传封面图
              </button>
            </div>
          )}
        </section>
      </div>

      {/* ============ 右：实时预览 ============ */}
      <aside className={styles.previewCol}>
        <div className={styles.previewHead}>
          <span className={styles.previewCount}>
            {pageCount} 页 · {ratio}
          </span>
          <span className="gt-small gt-muted">{title}</span>
        </div>
        <div className={styles.previewList}>
          {pageCount === 0 ? (
            <div className="gt-empty">
              <span className="gt-empty__mark">⋯</span>
              输入正文后自动分页。
            </div>
          ) : (
            Array.from({ length: pageCount }).map((_, index) => (
              <div
                key={index}
                className={styles.cardThumb}
                onClick={() => void onZoomPage(index)}
                title="点击放大"
              >
                <div
                  className={styles.cardThumbStage}
                  style={{ height: Math.round(170 * (pageSize.h / pageSize.w)) }}
                >
                  <div
                    ref={el => {
                      thumbRefs.current[index] = el;
                    }}
                    className={styles.cardThumbHost}
                  />
                </div>
                <span className={styles.cardIndex}>{index + 1}</span>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ============ 底：操作栏 ============ */}
      <div className={styles.actionBar}>
        <button
          type="button"
          className="gt-btn"
          onClick={() => void onCopyPage(0)}
          disabled={pageCount === 0}
        >
          复制首页
        </button>
        <button
          type="button"
          className="gt-btn gt-btn--primary"
          onClick={() => void onExportAll()}
          disabled={exporting || pageCount === 0}
        >
          {exporting ? `导出中… ${progress}` : `批量导出 PNG（${pageCount} 页）`}
        </button>
      </div>

      {/* ============ 放大弹层 ============ */}
      {zoom ? (
        <div className={styles.zoomOverlay} onClick={() => setZoom(null)}>
          <div className={styles.zoomCard} onClick={e => e.stopPropagation()}>
            <img src={zoom.url} alt={`第 ${zoom.index + 1} 页`} />
            <button type="button" className="gt-btn gt-btn--sm gt-btn--ghost" onClick={() => setZoom(null)}>
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
