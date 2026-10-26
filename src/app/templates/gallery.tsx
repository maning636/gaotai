"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { renderTemplatePreview } from "../../lib/markdown";
import type { LayoutTemplate } from "../../lib/layout-template";
import { PhonePreview } from "./phone-preview";
import styles from "./templates.module.css";

/**
 * 模板画廊：左卡片、右手机。
 *
 * 卡片上放的是「一眼可辨的排版长相」，右侧手机放的是同一份示例稿
 * 按当前选中模板的完整渲染。用户先扫卡片挑大方向，再在手机里确认细节，
 * 最后点「使用这套」才真正落到稿件上——点击卡片本身**不写任何后端状态**。
 *
 * 来源徽标跟编辑器里那个下拉的 optgroup 一一对应：
 *   builtin → 内置配色；imported → 随包导入；custom → 自己做的。
 */

/** 与 layout/panel.tsx 保持同一份示例稿，两边预览结果一致。 */
const SAMPLE = `# 一个标题

这是一段正文，里面有**加粗**和\`行内代码\`，还有[一个链接](https://example.com)。

> 一句引用，引用里也可以有**加粗**。

- 列表第一项
- 列表第二项

\`\`\`js
const answer = 42;
\`\`\`

| 名称 | 数值 |
| --- | --- |
| 甲 | 1 |
| 乙 | 2 |

---
`;

const SOURCE_LABEL: Record<LayoutTemplate["source"], string> = {
  builtin: "内置",
  imported: "随包",
  custom: "我的",
};

/**
 * 卡片徽标：随包模板按来源再细分一层。
 * 纯 builtin 是代码里的三套配色；builtin:wedraft-* 与 builtin:rico-* 都是
 * resources/layout-packs 里的随包样式包（layout-store 统一标成 builtin），
 * 但用户需要一眼看出「这套从哪来」。
 */
function badgeOf(template: LayoutTemplate): string {
  if (template.source === "custom") return SOURCE_LABEL.custom;
  if (template.id.startsWith("builtin:wedraft-")) return "WeDraft";
  if (template.id.startsWith("builtin:rico-")) return "rico";
  return SOURCE_LABEL.builtin;
}

type GalleryProps = {
  /** 稿件 id：有值才允许「使用这套」把模板应用回去。 */
  projectId?: string;
};

type ProjectBrief = {
  title: string;
  currentTemplateId: string;
};

export function Gallery({ projectId }: GalleryProps) {
  const [templates, setTemplates] = useState<LayoutTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [project, setProject] = useState<ProjectBrief | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/layout-templates", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "读取模板失败。");
      const list: LayoutTemplate[] = Array.isArray(body.templates) ? body.templates : [];
      setTemplates(list);

      // 带 ?project=<id> 时，先拿这篇稿子的偏好，让「当前使用」那套默认展开；
      // 没有稿件时默认展开第一套。
      let preferredId = "";
      if (projectId) {
        const [projectResp, themeResp] = await Promise.all([
          fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" }),
          fetch(`/api/wechat/theme?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" }),
        ]);
        const projectBody = await projectResp.json();
        if (!projectResp.ok) throw new Error(projectBody.error ?? "稿件不存在。");
        const themeBody = themeResp.ok ? await themeResp.json() : {};
        const currentId = typeof themeBody.templateId === "string" ? themeBody.templateId : "";
        preferredId = currentId;
        setProject({
          title: projectBody.project?.title ?? "",
          currentTemplateId: currentId,
        });
      } else {
        setProject(null);
      }

      // 之前的选中项还活着就保留；否则落到「当前使用」；再不行落到第一套。
      setSelectedId(prev => {
        if (prev && list.some(item => item.id === prev)) return prev;
        if (preferredId && list.some(item => item.id === preferredId)) return preferredId;
        return list[0]?.id ?? "";
      });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取模板失败。");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => templates.find(item => item.id === selectedId),
    [templates, selectedId],
  );

  /**
   * 卡片的缩略图：把示例稿按该模板渲染成整段 HTML。
   *
   * 每张卡各算一遍，不共享渲染产物——预览尺寸和手机上不一样，
   * 各自用各自的容器缩放，省得为了复用多一层缓存。
   */
  function renderCardPreview(template: LayoutTemplate): string {
    try {
      return renderTemplatePreview(SAMPLE, template);
    } catch {
      return "";
    }
  }

  return (
    <div className={styles.layout}>
      <div className={styles.gridWrap}>
        <p className={styles.hint}>
          平铺看排版：卡片里的预览是同一份示例稿按该模板渲染的。点卡片只切右侧手机，不落库。
        </p>

        {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
        {loading ? (
          <div className="gt-empty">
            <span className="gt-empty__mark">⋯</span>
            模板清单读取中…
          </div>
        ) : templates.length === 0 ? (
          <div className="gt-empty">
            <span className="gt-empty__mark">?</span>
            还没有模板。
          </div>
        ) : (
          <div className={styles.grid} role="list">
            {templates.map(template => {
              const isCurrent = project?.currentTemplateId === template.id;
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
                      onClick={() => setSelectedId(template.id)}
                    >
                      {isPicked ? "看效果" : "选这套"}
                    </button>
                    {isCurrent ? <span className={styles.currentTag}>当前使用</span> : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <aside className={styles.previewCol}>
        <PhonePreview
          template={selected}
          projectTitle={project?.title}
          projectId={projectId}
        />
      </aside>
    </div>
  );
}
