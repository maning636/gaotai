"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PART_CATALOG,
  defaultPartTemplate,
  templatePlaceholders,
  type LayoutPart,
  type LayoutPartKey,
  type LayoutTemplate,
} from "../../lib/layout-template";
import { PhonePreview } from "../templates/phone-preview";
import styles from "./panel.module.css";

/**
 * 排版模板页。
 *
 * 这一页做的是「让样式能沉淀下来」这件事：
 *
 * 1. **导入**：外面来的样式包（像 skills 那样一份一个目录、一份 JSON）贴进来；
 * 2. **取舍**：包里有多少部件都行，逐个勾——不要的（比如作者自己写的头和尾）不勾就不输出；
 * 3. **固化**：勾完存成一套命名模板，之后每篇稿子都能选它；
 * 4. **迭代**：模板存在库里，随时改色值、改某个部件的 html，再存一次就是新版本。
 *
 * 内置的三套配色是只读样板，要改先「复制一份」。
 */

/** 色值的中文名。 */
const VAR_LABELS: Record<string, string> = {
  text: "正文色",
  heading: "标题色",
  muted: "次要文字色",
  codeBg: "代码底色",
  codeText: "行内代码色",
  border: "描边色",
  quoteBar: "引用竖线",
  surface: "表头底色",
  codeHeader: "代码标题条",
  codeShadow: "代码块阴影",
  dot1: "圆点一",
  dot2: "圆点二",
  dot3: "圆点三",
};

/** 颜色类的变量给个取色器，其余给普通输入框。 */
const COLOR_VARS = new Set([
  "text",
  "heading",
  "muted",
  "codeBg",
  "codeText",
  "border",
  "quoteBar",
  "surface",
  "codeHeader",
  "dot1",
  "dot2",
  "dot3",
]);

/** 值长得像颜色就配取色器，像不像由值本身说了算。 */
function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

type LoadState = "" | "loading" | "saving";

export default function LayoutPanel() {
  const [templates, setTemplates] = useState<LayoutTemplate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<LayoutTemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<LoadState>("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [imported, setImported] = useState<{ template: LayoutTemplate; warnings: string[] } | null>(null);

  const [expanded, setExpanded] = useState<LayoutPartKey | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const response = await fetch("/api/layout-templates", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "读取模板失败。");
      const list: LayoutTemplate[] = body.templates ?? [];
      setTemplates(list);
      setSelectedId(prev => (prev && list.some(item => item.id === prev) ? prev : list[0]?.id ?? ""));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取模板失败。");
    } finally {
      setState("");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 选中换模板时，把模板复制成一份草稿在本地改。
  useEffect(() => {
    const found = templates.find(item => item.id === selectedId);
    if (!found) {
      setDraft(null);
      return;
    }
    setDraft({
      ...found,
      vars: { ...found.vars },
      parts: found.parts.map(part => ({ ...part })),
    });
    setDirty(false);
  }, [templates, selectedId]);

  /**
   * 这个模板真正用到的变量。
   *
   * 只显示部件 html 里真的写了 `{{xxx}}` 的那些。
   * 显示一堆「改了没反应」的空色值框，只会让人以为稿台坏了——
   * 随包分发的样式包只带 3–8 个变量，而标准色表有 13 个。
   */
  const usedVars = useMemo(() => {
    if (!draft) return [] as string[];
    const html = draft.parts.map(part => part.html).join("\n");
    return templatePlaceholders(html);
  }, [draft]);

  /** 标准色表里、且这个模板真的用到的变量。 */
  const standardVars = useMemo(
    () => Object.keys(VAR_LABELS).filter(name => usedVars.includes(name)),
    [usedVars],
  );

  /** 包自己带的、稿台标准色表里没有的变量。 */
  const extraVars = useMemo(
    () => usedVars.filter(name => !(name in VAR_LABELS)),
    [usedVars],
  );

  function patch(updater: (current: LayoutTemplate) => LayoutTemplate) {
    setDraft(current => (current ? updater(current) : current));
    setDirty(true);
    setNotice("");
  }

  /** 勾上/取消一个部件。勾上就接管，取消就退回内置默认。 */
  function togglePart(key: LayoutPartKey, on: boolean) {
    patch(current => {
      const existing = current.parts.find(part => part.key === key);
      if (!on) {
        return { ...current, parts: current.parts.filter(part => part.key !== key) };
      }
      if (existing) {
        return {
          ...current,
          parts: current.parts.map(part => (part.key === key ? { ...part, enabled: true } : part)),
        };
      }
      const meta = PART_CATALOG.find(item => item.key === key);
      const part: LayoutPart = {
        key,
        name: meta?.name ?? key,
        enabled: true,
        placement: meta?.placement ?? "inline",
        html: defaultPartTemplate(key),
        text: "",
      };
      return { ...current, parts: [...current.parts, part] };
    });
  }

  function editPartHtml(key: LayoutPartKey, html: string) {
    patch(current => ({
      ...current,
      parts: current.parts.map(part => (part.key === key ? { ...part, html } : part)),
    }));
  }

  function editPartText(key: LayoutPartKey, text: string) {
    patch(current => ({
      ...current,
      parts: current.parts.map(part => (part.key === key ? { ...part, text } : part)),
    }));
  }

  function editVar(name: string, value: string) {
    patch(current => ({ ...current, vars: { ...current.vars, [name]: value } }));
  }

  async function onSave() {
    if (!draft) return;
    setState("saving");
    setError("");
    try {
      const response = await fetch("/api/layout-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id || undefined,
          name: draft.name,
          description: draft.description,
          source: draft.source === "builtin" ? "custom" : draft.source,
          template: draft,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "保存失败。");
      setNotice("模板已存下。");
      setDirty(false);
      await load();
      setSelectedId(body.template?.id ?? draft.id);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "保存模板失败。");
    } finally {
      setState("");
    }
  }

  /** 把一套模板复制成自己的一份，用来改。 */
  async function onDuplicate(source: LayoutTemplate) {
    setError("");
    try {
      const copy: LayoutTemplate = {
        ...source,
        id: "",
        name: `${source.name} 副本`,
        description: source.description,
        source: "custom",
        vars: { ...source.vars },
        parts: source.parts.map(part => ({ ...part })),
      };
      const response = await fetch("/api/layout-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: copy.name,
          description: copy.description,
          source: "custom",
          template: copy,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "复制失败。");
      setNotice("复制好了，改完记得保存。");
      await load();
      setSelectedId(body.template?.id ?? "");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "复制模板失败。");
    }
  }

  async function onDelete(id: string) {
    setError("");
    try {
      const response = await fetch(`/api/layout-templates?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "删除失败。");
      setNotice("删掉了。");
      await load();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "删除模板失败。");
    }
  }

  async function onParsePack() {
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/layout-packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "样式包解析失败。");
      setImported({ template: body.template, warnings: body.warnings ?? [] });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "样式包解析失败。");
      setImported(null);
    }
  }

  async function onSaveImported() {
    if (!imported) return;
    setState("saving");
    setError("");
    try {
      const template: LayoutTemplate = {
        ...imported.template,
        id: "",
        name: imported.template.name || "导入的模板",
        source: "imported",
      };
      const response = await fetch("/api/layout-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          source: "imported",
          template,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "保存失败。");
      setNotice("样式包已经收进模板库。");
      setImported(null);
      setImportText("");
      setImportOpen(false);
      await load();
      setSelectedId(body.template?.id ?? "");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "保存样式包失败。");
    } finally {
      setState("");
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, typeof PART_CATALOG>();
    for (const meta of PART_CATALOG) {
      const list = map.get(meta.group) ?? [];
      list.push(meta);
      map.set(meta.group, list);
    }
    return [...map.entries()];
  }, []);

  /**
   * 模板库分组。
   *
   * 内置的几十套主题平铺成一长条根本没法挑，
   * 所以按「内置配色 / 随包主题 / 我的」分三段。
   */
  const templateGroups = useMemo(() => {
    const palettes: LayoutTemplate[] = [];
    const packs: LayoutTemplate[] = [];
    const mine: LayoutTemplate[] = [];
    for (const item of templates) {
      if (item.id.startsWith("builtin:rico-") || item.id.startsWith("builtin:wedraft-")) packs.push(item);
      else if (item.source === "builtin") palettes.push(item);
      else mine.push(item);
    }
    return [
      ["内置配色", palettes],
      ["随包主题", packs],
      ["我的模板", mine],
    ] as const;
  }, [templates]);

  const isBuiltin = draft?.source === "builtin";

  return (
    <div className="gt-stack gt-stack--lg">
      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

      <div className={styles.manage}>
        <aside className={styles.side}>
          <div className={styles.sideHead}>
            <h2 className="gt-panel__title" style={{ margin: 0 }}>模板库</h2>
            <span className="gt-small gt-muted">{state === "loading" ? "读取中…" : `${templates.length} 套`}</span>
            <button className="gt-btn gt-btn--sm gt-btn--primary" type="button" onClick={() => setImportOpen(open => !open)}>
              {importOpen ? "收起导入" : "导入样式包"}
            </button>
          </div>

          {importOpen ? (
            <section className="gt-panel gt-panel--flat gt-stack gt-stack--sm" style={{ padding: "12px" }}>
              <p className="gt-small gt-muted" style={{ margin: 0 }}>
                把样式包的 JSON 贴进来。稿台只认部件，不认包的来历——包里有的部件会列出来让你勾，不认识的会直接忽略。
              </p>
              <textarea
                className="gt-textarea gt-textarea--mono gt-scroll"
                rows={6}
                value={importText}
                placeholder='{ "name": "包名", "vars": { "text": "#333333" }, "parts": { "paragraph": { "html": "<p style=\"...\"> {{content}} </p>" } } }'
                onChange={event => {
                  setImportText(event.target.value);
                  setImported(null);
                }}
              />
              <div className="gt-row">
                <button className="gt-btn" type="button" onClick={() => void onParsePack()} disabled={!importText.trim()}>
                  解析
                </button>
                {imported ? (
                  <button className="gt-btn gt-btn--primary" type="button" onClick={() => void onSaveImported()}>
                    存进模板库
                  </button>
                ) : null}
              </div>
              {imported ? (
                <div className="gt-stack gt-stack--sm">
                  {imported.warnings.map(warning => (
                    <div className="gt-alert gt-alert--warn" key={warning}>
                      {warning}
                    </div>
                  ))}
                  <div className="gt-small gt-muted">
                    认出 {imported.template.parts.length} 个部件：
                    {imported.template.parts.map(part => part.name).join("、") || "（无）"}
                    。存进模板库之后还能逐个取舍。
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          <div className={styles.tiles}>
            {templateGroups.map(([title, items]) =>
              items.length ? (
                <div key={title}>
                  <div className={styles.groupLabel}>{title}</div>
                  <div className={styles.tileGrid}>
                    {items.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        title={item.name}
                        className={`${styles.tile}${item.id === selectedId ? " " + styles.tileActive : ""}`}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <span className={styles.tileName}>{item.name}</span>
                        <span className={styles.tileTag}>{item.id.startsWith("builtin:wedraft-") ? "WeDraft" : item.id.startsWith("builtin:rico-") ? "rico" : item.source === "builtin" ? "内置" : "我的"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null,
            )}
            {!templates.length && state !== "loading" ? (
              <div className="gt-empty">
                <span className="gt-empty__mark">?</span>
                还没有模板。
              </div>
            ) : null}
          </div>
        </aside>

        <section className={`gt-panel gt-panel--flat gt-stack ${styles.editorCol}`}>
          {draft ? (
            <>
              <div className="gt-panel__head">
                <div>
                  <h2 className="gt-panel__title">{draft.name}</h2>
                  <p className="gt-small gt-muted" style={{ margin: "4px 0 0" }}>
                    {isBuiltin
                      ? "内置配色是只读的。想改就复制一份，改完存成自己的模板。"
                      : "改完点保存。改过的部件会立刻在右边预览里见效。"}
                  </p>
                </div>
                {isBuiltin ? (
                  <button className="gt-btn" type="button" onClick={() => void onDuplicate(draft)}>
                    复制一份来改
                  </button>
                ) : (
                  <div className="gt-row">
                    <button
                      className="gt-btn gt-btn--sm gt-btn--danger"
                      type="button"
                      onClick={() => void onDelete(draft.id)}
                    >
                      删除
                    </button>
                    <button
                      className="gt-btn gt-btn--primary"
                      type="button"
                      onClick={() => void onSave()}
                      disabled={state === "saving" || !dirty}
                    >
                      {state === "saving" ? "保存中…" : dirty ? "保存" : "已保存"}
                    </button>
                  </div>
                )}
              </div>

              {!isBuiltin ? (
                <div className="gt-row">
                  <label className="gt-field" style={{ minWidth: "200px", flex: "1" }}>
                    <span className="gt-label">名称</span>
                    <input
                      className="gt-input"
                      value={draft.name}
                      onChange={event => patch(current => ({ ...current, name: event.target.value }))}
                    />
                  </label>
                  <label className="gt-field" style={{ minWidth: "220px", flex: "1" }}>
                    <span className="gt-label">一句话说明</span>
                    <input
                      className="gt-input"
                      value={draft.description}
                      placeholder="这套排版适合什么稿子"
                      onChange={event => patch(current => ({ ...current, description: event.target.value }))}
                    />
                  </label>
                </div>
              ) : null}

              <div>
                <h3 className="gt-heading" style={{ fontSize: "15px" }}>
                  颜色
                </h3>
                <p className="gt-small gt-muted" style={{ margin: "4px 0 10px" }}>
                  改一个色值，全篇跟着变。部件里的 html 写的是 <code>{"{{变量名}}"}</code>，取值就来自这张表。
                </p>
                <div className={`gt-grid gt-grid--3 ${styles.varGrid}`}>
                  {standardVars.map(name => (
                    <label className="gt-field" key={name}>
                      <span className="gt-label">
                        {VAR_LABELS[name]} · <code>{name}</code>
                      </span>
                      <div className="gt-row">
                        {COLOR_VARS.has(name) ? (
                          <input
                            type="color"
                            value={/^#[0-9a-fA-F]{6}$/.test(draft.vars[name] ?? "") ? draft.vars[name] : "#000000"}
                            onChange={event => editVar(name, event.target.value)}
                            style={{ width: "36px", height: "34px", padding: "2px" }}
                            aria-label={`${VAR_LABELS[name]} 取色`}
                          />
                        ) : null}
                        <input
                          className="gt-input gt-mono"
                          value={draft.vars[name] ?? ""}
                          onChange={event => editVar(name, event.target.value)}
                        />
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {extraVars.length ? (
                <div>
                  <h3 className="gt-heading" style={{ fontSize: "15px" }}>
                    包里的自定义变量
                  </h3>
                  <p className="gt-small gt-muted" style={{ margin: "4px 0 10px" }}>
                    样式包自己带的变量。部件的 html 里写的是
                    <code>{"{{变量名}}"}</code>，但这张表里没有的那几个，就是包的作者自己加的。
                  </p>
                  <div className={`gt-grid gt-grid--3 ${styles.varGrid}`}>
                    {extraVars.map(name => (
                      <label className="gt-field" key={name}>
                        <span className="gt-label">
                          自定义 · <code>{name}</code>
                        </span>
                        <div className="gt-row">
                          {isHexColor(draft.vars[name] ?? "") ? (
                            <input
                              type="color"
                              value={draft.vars[name] as string}
                              onChange={event => editVar(name, event.target.value)}
                              style={{ width: "36px", height: "34px", padding: "2px" }}
                              aria-label={`自定义变量 ${name} 取色`}
                            />
                          ) : null}
                          <input
                            className="gt-input gt-mono"
                            value={draft.vars[name] ?? ""}
                            onChange={event => editVar(name, event.target.value)}
                          />
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <h3 className="gt-heading" style={{ fontSize: "15px" }}>
                  部件
                </h3>
                <p className="gt-small gt-muted" style={{ margin: "4px 0 10px" }}>
                  勾上＝用这一套；不勾＝退回内置默认（开头、结尾这类整块不勾就不输出）。
                </p>
                <div className="gt-stack gt-stack--sm">
                  {groups.map(([group, items]) => (
                    <div key={group}>
                      <div className="gt-eyebrow">{group}</div>
                      <div className="gt-stack gt-stack--sm">
                        {items.map(meta => {
                          const part = draft.parts.find(item => item.key === meta.key);
                          const on = Boolean(part);
                          const open = expanded === meta.key;
                          return (
                            <div className="gt-panel gt-panel--sunken" key={meta.key} style={{ padding: "10px 12px" }}>
                              <div className="gt-row gt-row--between">
                                <label className="gt-check">
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={event => togglePart(meta.key, event.target.checked)}
                                  />
                                  <span>
                                    {meta.name}
                                    <span className="gt-small gt-muted"> · {meta.hint}</span>
                                  </span>
                                </label>
                                <button
                                  className="gt-btn gt-btn--sm gt-btn--ghost"
                                  type="button"
                                  onClick={() => setExpanded(open ? null : meta.key)}
                                >
                                  {open ? "收起" : "展开"}
                                </button>
                              </div>
                              {open ? (
                                <div className="gt-stack gt-stack--sm" style={{ marginTop: "10px" }}>
                                  {meta.placement === "head" || meta.placement === "tail" ? (
                                    <label className="gt-field">
                                      <span className="gt-label">固定文本</span>
                                      <input
                                        className="gt-input"
                                        value={part?.text ?? ""}
                                        placeholder="留空＝这一块不输出"
                                        onChange={event => editPartText(meta.key, event.target.value)}
                                      />
                                    </label>
                                  ) : null}
                                  <label className="gt-field">
                                    <span className="gt-label">HTML 模板</span>
                                    <textarea
                                      className="gt-textarea gt-textarea--mono gt-scroll"
                                      rows={4}
                                      value={part?.html ?? defaultPartTemplate(meta.key)}
                                      onChange={event => editPartHtml(meta.key, event.target.value)}
                                    />
                                  </label>
                                  <p className="gt-small gt-muted" style={{ margin: 0 }}>
                                    <code>{"{{content}}"}</code> 是正文，<code>{"{{tag}}"}</code> 是标签名，
                                    <code>{"{{headingSize}}"}</code> 是标题字号，<code>{"{{src}}"}</code>、
                                    <code>{"{{href}}"}</code> 等是这一处的具体值。
                                  </p>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="gt-empty">
              <span className="gt-empty__mark">?</span>
              先在左边选一套模板。
            </div>
          )}
        </section>

        <aside className={styles.phoneCol}>
          {draft ? (
            <PhonePreview template={draft} showApply={false} fitHeight="calc(100vh - 190px)" />
          ) : (
            <div className="gt-empty" style={{ marginTop: 60 }}>
              <span className="gt-empty__mark">?</span>
              选一套模板，右边就是它的样子。
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
