"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { STYLE_OPTIONS } from "../../../../lib/ai-image/styles";
import type { UnsplashPhoto } from "../../../../lib/ai-image/unsplash";
import styles from "./media-picker.module.css";

/**
 * AI 配图工作台：封面媒体选择器。
 *
 * 三个 Tab：
 * 1. AI 生图 —— 选风格 + 输入主题（可从文章提取）→ 调 /api/ai-image/generate；
 * 2. Unsplash 搜索 —— 关键词 + 热门标签 → 调 /api/ai-image/unsplash，30 分钟缓存；
 * 3. 本地图片 —— 文件上传。
 *
 * 点选一张图后通过 onSelect(dataUrl) 回调给父组件做封面。
 */

type MediaPickerProps = {
  /** 稿件正文，供「从文章提取」使用。 */
  articleContent: string;
  /** 选中一张封面图（dataUrl）。 */
  onSelect: (dataUrl: string) => void;
};

type TabId = "ai" | "unsplash" | "local";

/** 生成的图（b64 或 url）。 */
type GeneratedImage = { b64Json?: string; url?: string };

/** Unsplash 搜索缓存条目。 */
type UnsplashCacheEntry = {
  photos: UnsplashPhoto[];
  expiresAt: number;
};

/** 30 分钟缓存。 */
const UNSPLASH_CACHE_TTL_MS = 30 * 60 * 1000;
const unsplashCache = new Map<string, UnsplashCacheEntry>();

const HOT_TAGS = ["科技", "自然", "商务", "城市", "抽象"];

export function MediaPicker({ articleContent, onSelect }: MediaPickerProps) {
  const [tab, setTab] = useState<TabId>("ai");

  // AI 生图状态。
  const [style, setStyle] = useState<string>("clay");
  const [prompt, setPrompt] = useState<string>("");
  const [topics, setTopics] = useState<string[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [error, setError] = useState<string>("");

  // Unsplash 状态。
  const [query, setQuery] = useState<string>("");
  const [photos, setPhotos] = useState<UnsplashPhoto[]>([]);
  const [searching, setSearching] = useState(false);
  const [unsplashError, setUnsplashError] = useState<string>("");

  // 本地上传。
  const [localName, setLocalName] = useState<string>("");
  const fileInput = useRef<HTMLInputElement>(null);

  // 切 Tab 时清掉错误提示。
  useEffect(() => {
    setError("");
    setUnsplashError("");
  }, [tab]);

  /** 从文章提取主题。 */
  const onExtractTopics = useCallback(async () => {
    if (extracting) return;
    if (!articleContent.trim()) {
      setError("正文还是空的，先写完正文再提取主题。");
      return;
    }
    setExtracting(true);
    setError("");
    try {
      const response = await fetch("/api/ai-image/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: articleContent }),
      });
      const body = (await response.json()) as { topics?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "提取主题失败。");
      setTopics(body.topics ?? []);
      // 自动填第一个主题，省一次点击。
      if ((body.topics?.length ?? 0) > 0 && !prompt) setPrompt(body.topics![0]);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "提取主题失败。");
    } finally {
      setExtracting(false);
    }
  }, [articleContent, extracting, prompt]);

  /** 把一张图（b64 或 url）转成 dataUrl，选中后回传。 */
  const onPickImage = useCallback(
    async (image: GeneratedImage) => {
      setError("");
      try {
        const dataUrl = await toDataUrl(image);
        onSelect(dataUrl);
      } catch (issue) {
        setError(issue instanceof Error ? issue.message : "这张图加载失败，换一张试试。");
      }
    },
    [onSelect],
  );

  /** 生成 AI 图。 */
  const onGenerate = useCallback(async () => {
    if (generating) return;
    if (!prompt.trim()) {
      setError("请先输入配图主题。");
      return;
    }
    setGenerating(true);
    setError("");
    setSelectedIndex(null);
    try {
      const response = await fetch("/api/ai-image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, style, size: "1024x1024", n: 2 }),
      });
      const body = (await response.json()) as { images?: GeneratedImage[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "AI 生图失败。");
      const got = body.images ?? [];
      setImages(got);
      if (got.length === 1) void onPickImage(got[0]);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "AI 生图失败。");
    } finally {
      setGenerating(false);
    }
  }, [generating, prompt, style, onPickImage]);

  /** 点选一张已生成的图：标成选中并回传。 */
  const onPickGenerated = useCallback(
    (index: number) => {
      const image = images[index];
      if (!image) return;
      setSelectedIndex(index);
      void onPickImage(image);
    },
    [images, onPickImage],
  );

  /** Unsplash 搜索。 */
  const onSearch = useCallback(
    async (keyword: string) => {
      const term = keyword.trim();
      if (!term || searching) return;
      setQuery(term);
      setSearching(true);
      setUnsplashError("");
      try {
        const cached = unsplashCache.get(term);
        if (cached && cached.expiresAt > Date.now()) {
          setPhotos(cached.photos);
          return;
        }
        const response = await fetch(
          `/api/ai-image/unsplash?q=${encodeURIComponent(term)}&page=1&orientation=landscape`,
        );
        const body = (await response.json()) as { photos?: UnsplashPhoto[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "搜索失败。");
        const got = body.photos ?? [];
        unsplashCache.set(term, { photos: got, expiresAt: Date.now() + UNSPLASH_CACHE_TTL_MS });
        setPhotos(got);
      } catch (issue) {
        setUnsplashError(issue instanceof Error ? issue.message : "搜索失败。");
      } finally {
        setSearching(false);
      }
    },
    [searching],
  );

  /** 点选一张 Unsplash 图：拉原图转 dataUrl 并回传。 */
  const onPickUnsplash = useCallback(
    async (photo: UnsplashPhoto) => {
      setUnsplashError("");
      try {
        const dataUrl = await fetchToDataUrl(photo.urls.regular);
        onSelect(dataUrl);
      } catch {
        setUnsplashError("这张图下载失败，换一张试试。");
      }
    },
    [onSelect],
  );

  /** 本地上传。 */
  const onLocalUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setLocalName(file.name);
        onSelect(String(reader.result ?? ""));
      };
      reader.readAsDataURL(file);
    },
    [onSelect],
  );

  return (
    <div className={styles.mpRoot}>
      {/* Tab 栏 */}
      <div className={styles.mpTabs}>
        <button
          type="button"
          className={`${styles.mpTab}${tab === "ai" ? " " + styles.mpTabActive : ""}`}
          onClick={() => setTab("ai")}
        >
          AI 生图
        </button>
        <button
          type="button"
          className={`${styles.mpTab}${tab === "unsplash" ? " " + styles.mpTabActive : ""}`}
          onClick={() => setTab("unsplash")}
        >
          Unsplash
        </button>
        <button
          type="button"
          className={`${styles.mpTab}${tab === "local" ? " " + styles.mpTabActive : ""}`}
          onClick={() => setTab("local")}
        >
          本地图片
        </button>
      </div>

      {/* Tab 1：AI 生图 */}
      {tab === "ai" ? (
        <>
          <div className={styles.mpStyleRow}>
            {STYLE_OPTIONS.map(item => (
              <button
                key={item.id}
                type="button"
                className={`${styles.mpStyleBtn}${style === item.id ? " " + styles.mpStyleActive : ""}`}
                onClick={() => setStyle(item.id)}
                title={item.desc}
              >
                <span className={styles.mpStyleName}>{item.name}</span>
                <span className={styles.mpStyleDesc}>{item.desc}</span>
              </button>
            ))}
          </div>

          <div className={styles.mpField}>
            <label className={styles.mpLabel}>配图主题</label>
            <input
              className={styles.mpInput}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="例如：清晨的办公室窗边"
            />
          </div>

          <div className={styles.mpRow}>
            <button type="button" className="gt-btn gt-btn--sm gt-btn--ghost" onClick={() => void onExtractTopics()} disabled={extracting}>
              {extracting ? "提取中…" : "从文章提取"}
            </button>
            <span className={styles.mpHint}>用稿件内容自动想出 3-5 个配图主题</span>
          </div>

          {topics.length > 0 ? (
            <div className={styles.mpTopics}>
              {topics.map(topic => (
                <button
                  key={topic}
                  type="button"
                  className={styles.mpTopicChip}
                  onClick={() => setPrompt(topic)}
                >
                  {topic}
                </button>
              ))}
            </div>
          ) : null}

          <button type="button" className="gt-btn gt-btn--sm gt-btn--primary" onClick={() => void onGenerate()} disabled={generating}>
            {generating ? "生成中…" : "生成图片"}
          </button>

          {generating ? (
            <div className={styles.mpLoading}>
              <span className={styles.mpSpinner} />
              正在生成，可能要等一会儿…
            </div>
          ) : null}
          {error ? <div className={styles.mpError}>{error}</div> : null}

          {images.length > 0 ? (
            <div className={styles.mpGrid}>
              {images.map((image, index) => (
                <div
                  key={index}
                  className={`${styles.mpCell}${selectedIndex === index ? " " + styles.mpCellSelected : ""}`}
                  onClick={() => onPickGenerated(index)}
                  title="点击选为封面"
                >
                  <img src={image.b64Json ? `data:image/png;base64,${image.b64Json}` : image.url} alt={`AI 生成图 ${index + 1}`} />
                  <span className={`${styles.mpCellTag}${selectedIndex === index ? " " + styles.mpCellTagSelected : ""}`}>
                    {selectedIndex === index ? "已选" : "选为封面"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {/* Tab 2：Unsplash */}
      {tab === "unsplash" ? (
        <>
          <div className={styles.mpRow}>
            <input
              className={styles.mpInput}
              style={{ flex: 1 }}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") void onSearch(query);
              }}
              placeholder="搜索关键词，例如：城市夜景"
            />
            <button type="button" className="gt-btn gt-btn--sm" onClick={() => void onSearch(query)} disabled={searching}>
              {searching ? "搜索中…" : "搜索"}
            </button>
          </div>

          <div className={styles.mpTopics}>
            {HOT_TAGS.map(tag => (
              <button key={tag} type="button" className={styles.mpTopicChip} onClick={() => void onSearch(tag)}>
                {tag}
              </button>
            ))}
          </div>

          {searching ? (
            <div className={styles.mpLoading}>
              <span className={styles.mpSpinner} />
              正在搜索…
            </div>
          ) : null}
          {unsplashError ? <div className={styles.mpError}>{unsplashError}</div> : null}

          {photos.length > 0 ? (
            <div className={styles.mpGrid}>
              {photos.map(photo => (
                <div key={photo.id} className={styles.mpCell} onClick={() => void onPickUnsplash(photo)} title={photo.alt_description ?? "点击选为封面"}>
                  <img src={photo.urls.small} alt={photo.alt_description ?? "Unsplash 图片"} loading="lazy" />
                  <span className={styles.mpCellTag}>选为封面</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {/* Tab 3：本地图片 */}
      {tab === "local" ? (
        <>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={onLocalUpload}
          />
          <div className={styles.mpDrop} onClick={() => fileInput.current?.click()}>
            <span>点击选择本地图片</span>
            <span className={styles.mpHint}>支持 PNG / JPG / WebP</span>
          </div>
          {localName ? <div className={styles.mpHint}>已选：{localName}</div> : null}
        </>
      ) : null}
    </div>
  );
}

/** 把生成结果转成 dataUrl：b64 直接用，url 拉下来转。 */
async function toDataUrl(image: GeneratedImage): Promise<string> {
  if (image.b64Json) return `data:image/png;base64,${image.b64Json}`;
  if (!image.url) throw new Error("这张图没有可用的数据。");
  return fetchToDataUrl(image.url);
}

/** 拉一张远程图转 dataUrl。 */
async function fetchToDataUrl(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`下载图片失败（HTTP ${response.status}）。`);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(blob);
  });
}
