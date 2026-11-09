"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { renderTemplatePreview } from "../../../../lib/markdown";
import type { LayoutTemplate } from "../../../../lib/layout-template";
import { inlineCustomCss } from "../../../../lib/custom-css/inliner";
import { PREVIEW_SAMPLE } from "../../../../lib/preview-sample";
import { PhonePreview } from "../../../templates/phone-preview";
import {
  CHART_KIND_HINTS,
  CHART_KIND_LABELS,
  CHART_KIND_PURPOSES,
  chartSpecSchema,
  type ChartKind,
} from "../../../../lib/chart-spec";
import { paragraphInsertOffset } from "../../../../lib/illustration-plan";
import { insertMarkdownAt } from "../../../../lib/editor-insert";
import styles from "./preview.module.css";

type IllustrationPlanItem = {
  id: string;
  kind: ChartKind;
  title: string;
  afterParagraph: number;
  anchorText: string;
  data: unknown;
  rationale: string;
};

/**
 * 排版预览面板（发布中心）。
 *
 * 编辑器只管文字；所有图片、图解和排版操作都在这里：
 *   ② AI 生图（手动制图 / 全文自动配图）→ ③ 配图提示词 → ④ 选模板 → ⑤ 自定义 CSS
 *   → ⑥ 公众号通道 → ⑦ 封面图 → ⑧ 推草稿
 * 左侧功能区从上到下就是这条流程，右侧手机常驻显示真实正文。
 *
 * 素材库在顶部——拖图到右侧手机预览即可插入正文，也可以在 AI 生图里生成图解。
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

type WechatAccountView = {
  id: string;
  name: string;
  appIdMasked: string;
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
  const [busy, setBusy] = useState<"" | "copy" | "draft" | "apply" | "test" | "prompt" | "upload">("");
  const [channel, setChannel] = useState<ChannelCheck | null>(null);
  const [cover, setCover] = useState<CoverState>({ configured: false, image: "", previewUrl: "" });
  const [draftResult, setDraftResult] = useState<DraftResult>(null);
  /** 公众号账号清单（多账号）。只有 1 个以下时不显示选择下拉。 */
  const [accounts, setAccounts] = useState<WechatAccountView[]>([]);
  /** 当前选中的账号 id。空串表示用默认账号。 */
  const [accountId, setAccountId] = useState("");
  /** 用户粘贴的自定义 CSS（仅作用于右侧预览）。 */
  const [customCss, setCustomCss] = useState("");
  /** 自定义 CSS 折叠区是否展开。 */
  const [cssOpen, setCssOpen] = useState(false);
  /** 可变正文：拖入图片后实时更新，不需要跳回编辑器。 */
  const [editableContent, setEditableContent] = useState(articleContent);
  /** 素材库图片列表。 */
  const [library, setLibrary] = useState<{ path: string; url: string }[]>([]);
  /** 拖拽时手机预览高亮提示。 */
  const [dragOver, setDragOver] = useState(false);
  /** 图解生成面板是否展开。 */
  const [showIllustration, setShowIllustration] = useState(false);
  const [illustrationKind, setIllustrationKind] = useState<ChartKind>("bar");
  const [illustrationTitle, setIllustrationTitle] = useState("");
  const [illustrationUnit, setIllustrationUnit] = useState("");
  const [illustrationSource, setIllustrationSource] = useState("");
  const [illustrationData, setIllustrationData] = useState("");
  const [illustrationPreview, setIllustrationPreview] = useState<{ url: string; width: number; height: number } | null>(null);
  const [illustrationBusy, setIllustrationBusy] = useState(false);
  const [illustrationError, setIllustrationError] = useState("");
  const [chartSamples, setChartSamples] = useState<Record<string, string> | null>(null);
  const [illustrationMode, setIllustrationMode] = useState<"manual" | "auto">("manual");
  const [autoPlanBusy, setAutoPlanBusy] = useState(false);
  const [autoPlanError, setAutoPlanError] = useState("");
  const [autoPlan, setAutoPlan] = useState<IllustrationPlanItem[]>([]);
  const [autoPlanSelected, setAutoPlanSelected] = useState<Record<string, boolean>>({});
  const [autoInsertBusy, setAutoInsertBusy] = useState(false);
  const [autoInsertResult, setAutoInsertResult] = useState<{ ok: number; fail: number; messages: string[] } | null>(null);
  const [autoWarnings, setAutoWarnings] = useState<string[]>([]);
  const [autoArticleLength, setAutoArticleLength] = useState(0);
  const [autoHasNumbers, setAutoHasNumbers] = useState(true);

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

  /** 加载素材库。 */
  const loadLibrary = useCallback(async () => {
    try {
      const response = await fetch("/api/files", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json().catch(() => ({}));
      if (Array.isArray(body)) setLibrary(body);
    } catch {
      // 读不到不阻断主流程
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!showIllustration || chartSamples) return;
    let alive = true;
    fetch("/api/illustration/samples", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("读取图解样例失败"))))
      .then((body: { samples?: Record<string, string> }) => {
        if (alive && body.samples) setChartSamples(body.samples);
      })
      .catch(() => {})
      .finally(() => { /* done */ });
    return () => { alive = false; };
  }, [showIllustration, chartSamples]);

  /**
   * 从素材库拖一张图到手机预览的指定位置：
   * dropIndex 是鼠标所在段落块的索引（从 0 开始），图片插到该块后面。
   */
  async function onDropImage(url: string, dropIndex?: number) {
    if (!url) return;
    const snippet = `![配图](${url})`;
    const blocks = editableContent.split(/\n\n+/);
    const insertAt = dropIndex !== undefined && dropIndex >= 0 && dropIndex < blocks.length
      ? dropIndex + 1
      : blocks.length;
    blocks.splice(insertAt, 0, snippet);
    const newContent = blocks.join("\n\n");
    await saveContent(newContent, "图已插入正文并保存。");
  }

  /**
   * 删除正文中的某张图片。
   * imageUrl 是图片在正文 Markdown 里的 URL，
   * 从 editableContent 中移除包含该 URL 的 `![...](url)` 行。
   */
  async function onDeleteImage(imageUrl: string) {
    if (!imageUrl) return;
    // 移除包含该 URL 的图片 Markdown 行（可能有空行包裹）
    const regex = new RegExp(
      `\\n*!\\[[^\\]]*\\]\\(${imageUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\n*`,
      "g",
    );
    const newContent = editableContent.replace(regex, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (newContent === editableContent) return;
    await saveContent(newContent, "图片已删除并保存。");
  }

  /** 保存正文到后端并更新本地状态。 */
  async function saveContent(newContent: string, successMsg: string) {
    setEditableContent(newContent);
    setDragOver(false);
    setNotice("正在保存…");
    try {
      const response = await fetch(`/api/projects/${projectId}/stages/article`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "保存失败");
      }
      setNotice(successMsg);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "保存失败");
    }
  }

  /** 从本机拖文件到手机预览指定位置：并行上传后逐张插入。 */
  async function onDropFiles(files: File[], dropIndex?: number) {
    if (!files.length) return;
    setBusy("upload");
    setDragOver(false);
    setError("");
    try {
      const urls = await Promise.all(
        files.map(async (file) => {
          const form = new FormData();
          form.append("file", file);
          const response = await fetch("/api/files", { method: "POST", body: form });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? `「${file.name}」上传失败`);
          return body.image?.url as string | undefined;
        }),
      );
      const blocks = editableContent.split(/\n\n+/);
      const insertIdx = dropIndex !== undefined && dropIndex >= 0 && dropIndex < blocks.length
        ? dropIndex + 1
        : blocks.length;
      for (const url of urls) {
        if (url) blocks.splice(insertIdx, 0, `![配图](${url})`);
      }
      const newContent = blocks.join("\n\n");
      setEditableContent(newContent);
      const saveResp = await fetch(`/api/projects/${projectId}/stages/article`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });
      if (!saveResp.ok) throw new Error("图片已插入但保存失败");
      await loadLibrary();
      setNotice(`已插入 ${files.length} 张图片并保存。`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "上传失败");
    } finally {
      setBusy("");
    }
  }

  /** 上传按钮：从本机选图上传到素材库。 */
  async function onUploadToLibrary(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setBusy("upload");
    try {
      await Promise.all(
        files.map(async (file) => {
          const form = new FormData();
          form.append("file", file);
          await fetch("/api/files", { method: "POST", body: form });
        }),
      );
      await loadLibrary();
      setNotice(`已上传 ${files.length} 张图片到素材库。`);
    } catch {
      setError("上传失败");
    } finally {
      setBusy("");
      if (event.target) event.target.value = "";
    }
  }

  /** 解析图解数据为 ChartSpec。 */
  function parseIllustrationSpec(): { spec?: unknown; error?: string } {
    const data = illustrationData.trim();
    if (!data) return { error: "数据不能为空。" };
    try {
      const json = JSON.parse(data);
      const parsed = chartSpecSchema.safeParse({ ...json, kind: illustrationKind, title: illustrationTitle, unit: illustrationUnit, source: illustrationSource });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: `${issue?.path?.join(".") ?? ""} ${issue?.message ?? "数据不对"}`.trim() };
      }
      return { spec: parsed.data };
    } catch {
      return { error: "数据不是合法 JSON。" };
    }
  }

  async function onGenerateIllustration() {
    if (illustrationBusy) return;
    const spec = parseIllustrationSpec();
    if (!spec.spec) {
      setIllustrationError(spec.error ?? "数据格式不对。");
      return;
    }
    setIllustrationBusy(true);
    setIllustrationError("");
    try {
      const response = await fetch("/api/illustration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(spec.spec),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "生成图解失败。");
      setIllustrationPreview({ url: body.url, width: body.width, height: body.height });
    } catch (issue) {
      setIllustrationError(issue instanceof Error ? issue.message : "生成图解失败。");
    } finally {
      setIllustrationBusy(false);
    }
  }

  function onInsertIllustration() {
    if (!illustrationPreview) return;
    const snippet = `![图解](${illustrationPreview.url})`;
    const blocks = editableContent.split(/\n\n+/);
    blocks.push(snippet);
    const newContent = blocks.join("\n\n");
    void saveContent(newContent, "图解已插入正文末尾。可在预览中拖动调整位置。");
    setIllustrationPreview(null);
    void loadLibrary();
  }

  async function onAnalyzeIllustration() {
    if (autoPlanBusy) return;
    setAutoPlanBusy(true);
    setAutoPlanError("");
    setAutoInsertResult(null);
    setAutoWarnings([]);
    setAutoPlan([]);
    setAutoPlanSelected({});
    try {
      const response = await fetch("/api/illustration/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "分析全文失败。");
      const plan = Array.isArray(body.plan) ? body.plan : [];
      setAutoPlan(plan);
      setAutoPlanSelected(Object.fromEntries(plan.map((item: IllustrationPlanItem) => [item.id, true])));
      setAutoWarnings(Array.isArray(body.warnings) ? body.warnings : []);
      setAutoArticleLength(typeof body.articleLength === "number" ? body.articleLength : 0);
      setAutoHasNumbers(body.hasNumbers !== false);
    } catch (issue) {
      setAutoPlanError(issue instanceof Error ? issue.message : "分析全文失败。");
    } finally {
      setAutoPlanBusy(false);
    }
  }

  function onTogglePlanItem(id: string) {
    setAutoPlanSelected(current => ({ ...current, [id]: !current[id] }));
  }

  function onEditPlanData(id: string, value: string) {
    setAutoPlan(current => current.map(item => (item.id === id ? { ...item, data: value } : item)));
  }

  function planDataText(item: IllustrationPlanItem): string {
    if (typeof item.data === "string") return item.data;
    try { return JSON.stringify(item.data, null, 2); } catch { return String(item.data); }
  }

  function parsePlanData(item: IllustrationPlanItem): { spec?: unknown; error?: string } {
    const raw = item.data;
    if (typeof raw !== "string") {
      const parsed = chartSpecSchema.safeParse(raw);
      return parsed.success ? { spec: parsed.data } : { error: "这份数据不是合法的图解数据。" };
    }
    try {
      const json = JSON.parse(raw);
      const parsed = chartSpecSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: `${issue?.path?.join(".") ?? ""} ${issue?.message ?? "数据不对"}`.trim() };
      }
      return { spec: parsed.data };
    } catch {
      return { error: "编辑后的数据不是合法 JSON。" };
    }
  }

  async function onGenerateAutoIllustration() {
    if (autoInsertBusy) return;
    const selectedItems = autoPlan.filter(item => autoPlanSelected[item.id]);
    if (!selectedItems.length) {
      setAutoPlanError("还没有勾选任何一条。");
      return;
    }
    setAutoInsertBusy(true);
    setAutoInsertResult(null);
    setAutoPlanError("");
    const ok: string[] = [];
    const fail: { title: string; reason: string }[] = [];
    let content = editableContent;

    try {
      for (const item of selectedItems) {
        const parsed = parsePlanData(item);
        if (!parsed.spec) {
          fail.push({ title: item.title, reason: parsed.error ?? "数据不对" });
          continue;
        }
        try {
          const response = await fetch("/api/illustration", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed.spec),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? "生成图解失败。");
          const snippet = `![${item.title}](${body.url})`;
          const offset = paragraphInsertOffset(content, item.afterParagraph);
          const { content: next } = insertMarkdownAt(content, offset, snippet);
          content = next;
          ok.push(item.title);
        } catch (issue) {
          fail.push({ title: item.title, reason: issue instanceof Error ? issue.message : "生成失败" });
        }
      }

      if (ok.length) {
        await saveContent(content, `已生成 ${ok.length} 张图并插入正文${fail.length ? `，${fail.length} 张失败` : ""}。`);
        void loadLibrary();
      }
      setAutoInsertResult({
        ok: ok.length,
        fail: fail.length,
        messages: [
          ...ok.map(title => `✓ ${title}`),
          ...fail.map(item => `✗ ${item.title}：${item.reason}`),
        ],
      });
      setAutoPlan([]);
      setAutoPlanSelected({});
    } finally {
      setAutoInsertBusy(false);
    }
  }

  const checkChannel = useCallback(async (forAccountId?: string) => {
    setBusy("test");
    setError("");
    try {
      const response = await fetch("/api/wechat/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forAccountId ? { accountId: forAccountId } : {}),
      });
      const body = (await response.json().catch(() => ({}))) as ChannelCheck;
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
      const body = await response.json().catch(() => ({}));
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
    // 账号清单：多账号时才有用。默认账号在通道检查里测（accountId 为空）。
    (async () => {
      try {
        const response = await fetch("/api/wechat/config", { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return;
        const list: WechatAccountView[] = Array.isArray(body.accounts) ? body.accounts : [];
        setAccounts(list);
      } catch {
        // 账号清单读不到不影响主流程
      }
    })();
  }, [checkChannel, checkCover]);

  const selected = useMemo(
    () => templates.find(item => item.id === selectedId),
    [templates, selectedId],
  );

  const hasArticle = editableContent.trim().length > 0;
  const channelReady = channel?.ok ?? false;
  const coverReady = cover.configured;
  const draftReady = hasArticle && channelReady && coverReady;

  function renderCardPreview(template: LayoutTemplate): string {
    try {
      const html = renderTemplatePreview(PREVIEW_SAMPLE, template);
      if (customCss.trim()) {
        // 自定义 CSS 通过 inlineCustomCss 内联到预览里；fail-open，失败时原样返回。
        return inlineCustomCss(html, customCss, { rootSelector: ".gt-article-root" });
      }
      return html;
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
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error ?? `应用模板失败（HTTP ${response.status}）`);
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
        body: JSON.stringify({ title: projectTitle, article: editableContent }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error ?? `生成配图提示词失败（HTTP ${response.status}）`);
      setNotice(`配图提示词：${(body as { prompt?: string }).prompt ?? ""}`);
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
        body: JSON.stringify({ projectId, templateId: selected.id, content: editableContent }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error ?? `预览失败（HTTP ${response.status}）`);
      const html = String((body as { html?: string }).html ?? "");
      const text = String((body as { text?: string }).text ?? "");
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
    // 推送前重测所选账号（多账号时）——「先测后发」对每个账号都成立。
    const check = await checkChannel(accountId || undefined);
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
        body: JSON.stringify({ projectId, templateId: selected.id, ...(accountId ? { accountId } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error ?? `推送失败（HTTP ${response.status}）`);
      const result = body as { title?: string; uploadedImages?: number; cachedImages?: number };
      const uploaded = Number(result.uploadedImages ?? 0);
      const cached = Number(result.cachedImages ?? 0);
      setDraftResult({ ok: true, title: result.title ?? "", uploadedImages: uploaded });
      setNotice(
        [
          `已放进草稿箱：${result.title ?? "未命名"}`,
          uploaded > 0 ? `正文图片已上传 ${uploaded} 张到微信。` : "",
          cached > 0 ? `（${cached} 张复用缓存）` : "",
        ]
          .filter(Boolean)
          .join(""),
      );
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "推送失败。");
    } finally {
      setBusy("");
    }
  }

  /** 切公众号账号：换账号就重新测通道，通道状态是跟账号走的。 */
  async function onAccountChange(next: string) {
    setAccountId(next);
    setDraftResult(null);
    setError("");
    setNotice("");
    const check = await checkChannel(next || undefined);
    if (check && !check.ok) {
      setError(`这个公众号还没测通：${check.reason}。${check.hint}`);
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

        {/* 素材库：拖图到右侧手机预览即可插入正文 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <h2 className={styles.stepTitle}>素材库</h2>
            <span className="gt-small gt-muted" style={{ marginLeft: "auto" }}>
              拖到右侧手机预览即可插入正文
            </span>
          </div>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            style={{ display: "none" }}
            onChange={onUploadToLibrary}
            id="library-upload-input"
          />
          <div className={styles.stepBlock}>
            {library.length > 0 ? (
              <div className={styles.imageLibrary}>
                {library.map(image => (
                  <div
                    key={image.path}
                    className={styles.libraryItem}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/x-gaotai-image", image.url);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    title={image.path}
                  >
                    <img src={image.url} alt={image.path} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="gt-small gt-muted" style={{ margin: 0 }}>
                素材库是空的——上传几张图，然后拖到右边手机里。
              </p>
            )}
            <label
              className="gt-btn gt-btn--sm gt-btn--ghost"
              htmlFor="library-upload-input"
              style={{ cursor: "pointer", alignSelf: "flex-start" }}
            >
              {busy === "upload" ? "上传中…" : "+ 上传图片到素材库"}
            </label>
          </div>
        </section>

        {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
        {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}
        {!hasArticle ? (
          <div className="gt-alert gt-alert--warn">
            这篇稿子还没有正文。先回编辑器把「文章正文」走完，再回来排版。
          </div>
        ) : null}

        {/* ② AI 生图：手动制图 + 全文自动配图 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>2</span>
            <h2 className={styles.stepTitle}>AI 生图</h2>
            <button
              type="button"
              className="gt-btn gt-btn--sm gt-btn--ghost"
              style={{ marginLeft: "auto" }}
              onClick={() => setShowIllustration(prev => !prev)}
            >
              {showIllustration ? "收起" : "展开"}
            </button>
          </div>
          {showIllustration ? (
            <div className={styles.stepBlock}>
              <div className="gt-row" style={{ gap: "6px", marginBottom: "12px" }}>
                <button
                  type="button"
                  className={`gt-btn gt-btn--sm${illustrationMode === "manual" ? " gt-btn--primary" : ""}`}
                  onClick={() => { setIllustrationMode("manual"); setAutoPlanError(""); }}
                >
                  手动制图
                </button>
                <button
                  type="button"
                  className={`gt-btn gt-btn--sm${illustrationMode === "auto" ? " gt-btn--primary" : ""}`}
                  onClick={() => { setIllustrationMode("auto"); setIllustrationError(""); }}
                >
                  全文自动配图
                </button>
              </div>

              {illustrationMode === "manual" ? (
                <div className="gt-stack gt-stack--sm">
                  <div className="gt-chart-grid">
                    {(Object.keys(CHART_KIND_LABELS) as ChartKind[]).map(kind => (
                      <button
                        key={kind}
                        type="button"
                        className={`gt-chart-card${illustrationKind === kind ? " gt-chart-card--active" : ""}`}
                        onClick={() => { setIllustrationKind(kind); setIllustrationPreview(null); setIllustrationError(""); }}
                      >
                        <span className="gt-chart-card__thumb">
                          {chartSamples?.[kind] ? (
                            <img src={chartSamples[kind]} alt={CHART_KIND_LABELS[kind]} loading="lazy" />
                          ) : (
                            <span className="gt-chart-card__placeholder">{CHART_KIND_LABELS[kind]}</span>
                          )}
                        </span>
                        <span className="gt-chart-card__name">{CHART_KIND_LABELS[kind]}</span>
                        <span className="gt-chart-card__purpose">{CHART_KIND_PURPOSES[kind]}</span>
                      </button>
                    ))}
                  </div>

                  <label className="gt-field">
                    <span className="gt-label">标题</span>
                    <input className="gt-input" value={illustrationTitle} onChange={e => setIllustrationTitle(e.target.value)} placeholder="一句话说清这张图" />
                  </label>

                  <div className="gt-row" style={{ gap: "8px" }}>
                    <label className="gt-field" style={{ flex: 1 }}>
                      <span className="gt-label">单位（可选）</span>
                      <input className="gt-input" value={illustrationUnit} onChange={e => setIllustrationUnit(e.target.value)} placeholder="分钟 / 篇 / %" />
                    </label>
                    <label className="gt-field" style={{ flex: 1 }}>
                      <span className="gt-label">来源（可选）</span>
                      <input className="gt-input" value={illustrationSource} onChange={e => setIllustrationSource(e.target.value)} placeholder="2026-10 内部统计" />
                    </label>
                  </div>

                  <label className="gt-field">
                    <span className="gt-label">数据</span>
                    <textarea className="gt-textarea gt-textarea--mono" rows={6} value={illustrationData} onChange={e => setIllustrationData(e.target.value)} placeholder={CHART_KIND_HINTS[illustrationKind]} />
                  </label>

                  {illustrationError ? <div className="gt-alert gt-alert--error">{illustrationError}</div> : null}

                  <div className="gt-row">
                    <button className="gt-btn gt-btn--primary" type="button" onClick={() => void onGenerateIllustration()} disabled={illustrationBusy}>
                      {illustrationBusy ? "生成中…" : "生成预览"}
                    </button>
                    {illustrationPreview ? (
                      <button className="gt-btn" type="button" onClick={onInsertIllustration}>插入到正文</button>
                    ) : null}
                  </div>

                  {illustrationPreview ? (
                    <img src={illustrationPreview.url} alt="图解预览" style={{ width: "100%", border: "2px solid #1A1A1A", background: "#fff" }} />
                  ) : null}
                </div>
              ) : (
                <div className="gt-stack gt-stack--sm">
                  <div className="gt-row" style={{ gap: "8px" }}>
                    <button className="gt-btn gt-btn--primary" type="button" onClick={() => void onAnalyzeIllustration()} disabled={autoPlanBusy}>
                      {autoPlanBusy ? "正在通读全文…" : "分析全文"}
                    </button>
                    <span className="gt-small gt-muted">稿台通读正文，自动决定配几张图、配在什么位置。</span>
                  </div>

                  {autoArticleLength > 0 ? (
                    <p className="gt-small gt-muted" style={{ margin: 0 }}>
                      正文 {autoArticleLength} 字{autoHasNumbers ? "" : "，没有数字——只配结构类图。"}。
                    </p>
                  ) : null}

                  {autoPlanError ? <div className="gt-alert gt-alert--error">{autoPlanError}</div> : null}

                  {autoPlan.length ? (
                    <>
                      <div className="gt-stack gt-stack--sm">
                        {autoPlan.map(item => (
                          <div key={item.id} className="gt-chart-plan-card">
                            <label className="gt-chart-plan-card__head">
                              <input type="checkbox" checked={Boolean(autoPlanSelected[item.id])} onChange={() => onTogglePlanItem(item.id)} />
                              <span className="gt-chart-plan-card__kind">{CHART_KIND_LABELS[item.kind]}</span>
                              <span className="gt-chart-plan-card__title">{item.title}</span>
                            </label>
                            <p className="gt-chart-plan-card__where">插在第 {item.afterParagraph} 段之后：{item.anchorText || "（段落在文末）"}</p>
                            <p className="gt-chart-plan-card__why">为什么这里要图：{item.rationale}</p>
                            <details className="gt-chart-plan-card__data">
                              <summary>编辑数据</summary>
                              <textarea className="gt-textarea gt-textarea--mono" rows={4} value={planDataText(item)} onChange={e => onEditPlanData(item.id, e.target.value)} />
                            </details>
                          </div>
                        ))}
                      </div>
                      <div className="gt-row">
                        <button className="gt-btn gt-btn--primary" type="button" onClick={() => void onGenerateAutoIllustration()} disabled={autoInsertBusy}>
                          {autoInsertBusy ? "生成并插入中…" : `生成并插入已选（${autoPlan.filter(item => autoPlanSelected[item.id]).length} 张）`}
                        </button>
                      </div>
                    </>
                  ) : null}

                  {autoWarnings.length ? (
                    <div className="gt-alert gt-alert--warn">
                      {autoWarnings.map((w, i) => <div key={i}>{w}</div>)}
                    </div>
                  ) : null}

                  {autoInsertResult ? (
                    <div className="gt-alert gt-alert--info">
                      <div>成功 {autoInsertResult.ok} 张、失败 {autoInsertResult.fail} 张。</div>
                      {autoInsertResult.messages.map((m, i) => <div key={i}>{m}</div>)}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <p className={styles.stepDesc}>手动制图或全文自动配图，生成的图直接插入正文。</p>
          )}
        </section>

        {/* ③ 配图提示词 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>3</span>
            <h2 className={styles.stepTitle}>配图提示词</h2>
          </div>
          <div className={styles.stepBlock}>
            <button
              className="gt-btn gt-btn--sm gt-btn--ghost"
              type="button"
              onClick={() => void onImagePrompt()}
              disabled={busy !== ""}
            >
              {busy === "prompt" ? "生成中…" : "生成配图提示词"}
            </button>
          </div>
        </section>

        {/* ④ 选模板 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>4</span>
            <h2 className={styles.stepTitle}>选排版模板</h2>
            <Link className="gt-small" href={`/projects/${projectId}/cards`} style={{ marginLeft: "auto" }}>
              卡片模式 →
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

        {/* ⑤ 自定义 CSS：折叠文本框，粘贴后应用到右侧预览 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>5</span>
            <h2 className={styles.stepTitle}>自定义 CSS</h2>
            <button
              type="button"
              className="gt-btn gt-btn--sm gt-btn--ghost"
              style={{ marginLeft: "auto" }}
              onClick={() => setCssOpen(prev => !prev)}
            >
              {cssOpen ? "收起" : "展开"}
            </button>
          </div>
          {cssOpen ? (
            <div className={styles.stepBlock}>
              <p className={styles.stepDesc}>
                粘贴 CSS 并内联到右侧预览。只影响预览效果，不写入稿件。
              </p>
              <textarea
                value={customCss}
                onChange={event => setCustomCss(event.target.value)}
                placeholder={"例如：\n.gt-article-root p { color: #333; }\n.gt-article-root h2 { border-left: 4px solid #2563eb; }"}
                rows={6}
                spellCheck={false}
                style={{ width: "100%", fontFamily: "monospace", fontSize: "12px", padding: "8px" }}
              />
            </div>
          ) : (
            <p className={styles.stepDesc}>
              {customCss.trim() ? "已应用自定义 CSS（点击展开编辑）。" : "可粘贴 CSS 覆盖预览样式。"}
            </p>
          )}
        </section>

        {/* ⑥ 公众号通道 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>6</span>
            <h2 className={styles.stepTitle}>公众号通道</h2>
            <span
              className={`gt-tag ${channel === null ? "gt-tag--yellow" : channel.ok ? "gt-tag--green" : "gt-tag--pink"}`}
              style={{ marginLeft: "auto" }}
            >
              {channel === null ? "未测" : channel.ok ? "已通" : "不通"}
            </span>
          </div>
          {accounts.length > 0 ? (
            <div className={styles.stepBlock}>
              <label className="gt-field" style={{ maxWidth: "320px" }}>
                <span className="gt-label">推给哪个公众号</span>
                <select
                  className="gt-select"
                  value={accountId}
                  onChange={event => void onAccountChange(event.target.value)}
                  disabled={busy !== ""}
                >
                  <option value="">默认账号（.env）</option>
                  {accounts.map(account => (
                    <option key={account.id} value={account.id}>
                      {account.name || account.appIdMasked}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {channel && channel.ok ? (
            <p className={styles.stepDesc}>通道正常，可以推草稿。</p>
          ) : channel && !channel.ok ? (
            <div className={styles.stepBlock}>
              <p className={styles.stepDesc}>
                {channel.reason}。{channel.hint}
              </p>
              <div className="gt-row" style={{ gap: "8px" }}>
                <button className="gt-btn gt-btn--sm" type="button" onClick={() => void checkChannel(accountId || undefined)} disabled={busy !== ""}>
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
              <button className="gt-btn gt-btn--sm" type="button" onClick={() => void checkChannel(accountId || undefined)} disabled={busy !== ""}>
                {busy === "test" ? "测试中…" : "测试通道"}
              </button>
            </div>
          )}
        </section>

        {/* ⑦ 封面图 */}
        <section className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>7</span>
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

        {/* ⑧ 推草稿箱 */}
        <section className={`${styles.step} ${styles.stepFinal}`}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>8</span>
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

      {/* ============ 右侧：手机预览（常驻，支持拖拽插图） ============ */}
      <aside className={styles.previewCol}>
        <PhonePreview
          template={selected}
          content={editableContent}
          projectTitle={projectTitle}
          projectId={projectId}
          showApply={false}
          customCss={customCss}
          droppable
          dragOver={dragOver}
          onDragOverChange={setDragOver}
          onDropImage={onDropImage}
          onDropFiles={onDropFiles}
          onDeleteImage={onDeleteImage}
        />
      </aside>
    </div>
  );
}
