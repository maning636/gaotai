import { getDb, now, type AssetRow, type DraftRow, type EditRow, type MessageRow, type ProjectRow, type Stage, type StageResultRow, type StyleProfileRow } from "./db";
import { createId } from "./ids";

/**
 * 数据访问层。
 *
 * 所有读写都走这里，SQL 只出现在这一个文件里：
 * - 上层（阶段引擎、风格画像、页面）只关心「拿什么、给什么」；
 * - 需要新增字段或改表时，改动收敛在 db.ts 的 schema 与本文件的映射，
 *   不会散落到各个调用点。
 *
 * 约定：
 * - 时间戳一律用毫秒整数（db.now()）；
 * - 写操作后立即把 updated_at 刷成当前时间，并同步 project 的 updated_at，
 *   这样「最近修改的稿子」列表不需要额外聚合。
 */

export type ProjectPatch = {
  title?: string;
  topicId?: string;
  stage?: Stage;
};

/** 公众号侧的排版偏好与草稿状态，与 projects 一对一。 */
export type WxPreferenceRow = {
  project_id: string;
  theme: string;
  /** 排版模板 id。空字符串表示还在用内置配色。 */
  template_id: string;
  draft_media_id: string;
  draft_fingerprint: string;
  updated_at: number;
};

/** 排版模板库里的一行。template 列存的是模板 JSON。 */
export type LayoutTemplateRow = {
  id: string;
  name: string;
  description: string;
  source: string;
  template: string;
  created_at: number;
  updated_at: number;
};

export function listProjects(options: { topicId?: string; limit?: number } = {}): ProjectRow[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  // rowid 作为同毫秒写入的次级排序键：updated_at 只有毫秒精度，
  // 连续创建的稿件常常时间戳相同，没有次级键时列表顺序会随机跳动。
  if (options.topicId) {
    return db
      .prepare("SELECT * FROM projects WHERE topic_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(options.topicId, limit) as ProjectRow[];
  }
  return db.prepare("SELECT * FROM projects ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(limit) as ProjectRow[];
}

export function getProject(id: string): ProjectRow | null {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ?? null;
}

export function createProject(input: { title: string; topicId: string }): ProjectRow {
  const db = getDb();
  const timestamp = now();
  const row: ProjectRow = {
    id: createId("prj"),
    title: input.title.trim() || "未命名稿件",
    topic_id: input.topicId,
    stage: "brief",
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.prepare(
    "INSERT INTO projects (id, title, topic_id, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.title, row.topic_id, row.stage, row.created_at, row.updated_at);
  return row;
}

export function updateProject(id: string, patch: ProjectPatch): ProjectRow | null {
  const db = getDb();
  const existing = getProject(id);
  if (!existing) return null;
  const next: ProjectRow = {
    ...existing,
    title: patch.title !== undefined ? patch.title.trim() || existing.title : existing.title,
    topic_id: patch.topicId ?? existing.topic_id,
    stage: patch.stage ?? existing.stage,
    updated_at: now(),
  };
  db.prepare("UPDATE projects SET title = ?, topic_id = ?, stage = ?, updated_at = ? WHERE id = ?").run(
    next.title,
    next.topic_id,
    next.stage,
    next.updated_at,
    id,
  );
  return next;
}

export function deleteProject(id: string): boolean {
  const result = getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

/** 稿件的最新修改时间，供项目列表排序。 */
export function touchProject(id: string): void {
  getDb().prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), id);
}

export function listStageResults(projectId: string): StageResultRow[] {
  return getDb()
    .prepare("SELECT * FROM stage_results WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId) as StageResultRow[];
}

export function getStageResult(projectId: string, stage: Stage): StageResultRow | null {
  const row = getDb()
    .prepare("SELECT * FROM stage_results WHERE project_id = ? AND stage = ? ORDER BY updated_at DESC LIMIT 1")
    .get(projectId, stage) as StageResultRow | undefined;
  return row ?? null;
}

/** 写入阶段产出。同一个阶段只保留最新一份（草稿态覆盖），确认态也覆盖。 */
export function saveStageResult(input: {
  projectId: string;
  stage: Stage;
  content: string;
  status: "draft" | "confirmed";
}): StageResultRow {
  const db = getDb();
  const timestamp = now();
  const existing = getStageResult(input.projectId, input.stage);
  if (existing) {
    db.prepare(
      "UPDATE stage_results SET content = ?, status = ?, updated_at = ? WHERE id = ?",
    ).run(input.content, input.status, timestamp, existing.id);
    touchProject(input.projectId);
    return { ...existing, content: input.content, status: input.status, updated_at: timestamp };
  }
  const row: StageResultRow = {
    id: createId("stg"),
    project_id: input.projectId,
    stage: input.stage,
    content: input.content,
    status: input.status,
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.prepare(
    "INSERT INTO stage_results (id, project_id, stage, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.project_id, row.stage, row.content, row.status, row.created_at, row.updated_at);
  touchProject(input.projectId);
  return row;
}

export function appendMessage(input: {
  projectId: string;
  stage: Stage;
  role: "user" | "assistant";
  content: string;
}): MessageRow {
  const db = getDb();
  const row: MessageRow = {
    id: createId("msg"),
    project_id: input.projectId,
    stage: input.stage,
    role: input.role,
    content: input.content,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO messages (id, project_id, stage, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.project_id, row.stage, row.role, row.content, row.created_at);
  touchProject(input.projectId);
  return row;
}

export function listMessages(projectId: string, stage?: Stage): MessageRow[] {
  const db = getDb();
  if (stage) {
    return db
      .prepare("SELECT * FROM messages WHERE project_id = ? AND stage = ? ORDER BY created_at ASC")
      .all(projectId, stage) as MessageRow[];
  }
  return db
    .prepare("SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId) as MessageRow[];
}

export function clearMessages(projectId: string, stage: Stage): void {
  getDb().prepare("DELETE FROM messages WHERE project_id = ? AND stage = ?").run(projectId, stage);
}

/**
 * 记录一次人工修改。
 *
 * 这是风格画像的唯一证据来源：AI 写了什么不算数，人改成什么样才算数。
 * 前后文本都存原文，不做归一化——风格分析需要看到真实笔迹。
 */
export function recordEdit(input: {
  projectId: string;
  stage: Stage;
  beforeText: string;
  afterText: string;
}): EditRow {
  const db = getDb();
  const row: EditRow = {
    id: createId("edt"),
    project_id: input.projectId,
    stage: input.stage,
    before_text: input.beforeText,
    after_text: input.afterText,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO edits (id, project_id, stage, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.project_id, row.stage, row.before_text, row.after_text, row.created_at);
  touchProject(input.projectId);
  return row;
}

export function listEdits(options: { projectId?: string; topicId?: string; limit?: number } = {}): EditRow[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
  if (options.projectId) {
    return db
      .prepare("SELECT * FROM edits WHERE project_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(options.projectId, limit) as EditRow[];
  }
  if (options.topicId) {
    return db
      .prepare(
        "SELECT e.* FROM edits e JOIN projects p ON p.id = e.project_id WHERE p.topic_id = ? ORDER BY e.created_at ASC LIMIT ?",
      )
      .all(options.topicId, limit) as EditRow[];
  }
  return db.prepare("SELECT * FROM edits ORDER BY created_at ASC LIMIT ?").all(limit) as EditRow[];
}

export function countEdits(topicId: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM edits e JOIN projects p ON p.id = e.project_id WHERE p.topic_id = ?",
    )
    .get(topicId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function getStyleProfile(topicId: string): StyleProfileRow | null {
  const row = getDb().prepare("SELECT * FROM style_profiles WHERE topic_id = ?").get(topicId) as
    | StyleProfileRow
    | undefined;
  return row ?? null;
}

export function saveStyleProfile(topicId: string, profile: string): StyleProfileRow {
  const db = getDb();
  const timestamp = now();
  const existing = getStyleProfile(topicId);
  if (existing) {
    db.prepare("UPDATE style_profiles SET profile = ?, updated_at = ? WHERE id = ?").run(
      profile,
      timestamp,
      existing.id,
    );
    return { ...existing, profile, updated_at: timestamp };
  }
  const row: StyleProfileRow = {
    id: createId("sty"),
    topic_id: topicId,
    profile,
    updated_at: timestamp,
  };
  db.prepare("INSERT INTO style_profiles (id, topic_id, profile, updated_at) VALUES (?, ?, ?, ?)").run(
    row.id,
    row.topic_id,
    row.profile,
    row.updated_at,
  );
  return row;
}

export function listAssets(projectId?: string): AssetRow[] {
  const db = getDb();
  if (projectId) {
    return db
      .prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as AssetRow[];
  }
  return db.prepare("SELECT * FROM assets ORDER BY created_at DESC").all() as AssetRow[];
}

export function addAsset(input: {
  projectId?: string | null;
  kind: AssetRow["kind"];
  name: string;
  body: string;
}): AssetRow {
  const db = getDb();
  const row: AssetRow = {
    id: createId("ast"),
    project_id: input.projectId ?? null,
    kind: input.kind,
    name: input.name,
    body: input.body,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO assets (id, project_id, kind, name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.project_id, row.kind, row.name, row.body, row.created_at);
  return row;
}

/** 读取某稿件的公众号排版偏好；没有记录就是 null（表示还没推过、也没选过主题）。 */
export function getWxPreference(projectId: string): WxPreferenceRow | null {
  const row = getDb()
    .prepare(
      "SELECT project_id, theme, template_id, draft_media_id, draft_fingerprint, updated_at FROM wx_preferences WHERE project_id = ?",
    )
    .get(projectId) as WxPreferenceRow | undefined;
  return row ?? null;
}

/**
 * 写入/更新排版偏好，未传的字段沿用库里的旧值。
 *
 * 四个字段都可能被独立更新——选主题不改草稿状态，推草稿不改主题——所以这里
 * 只覆盖调用方显式给的值。用 ON CONFLICT 做 upsert：草稿接口在同一个请求里
 * 可能既要知道旧值又要写新值，分两次查询加一次判断会把并发场景搞得很脆。
 */
export function saveWxPreference(input: {
  projectId: string;
  theme?: string;
  templateId?: string;
  draftMediaId?: string;
  draftFingerprint?: string;
}): WxPreferenceRow {
  const db = getDb();
  const timestamp = now();
  const existing = getWxPreference(input.projectId);
  const theme = input.theme ?? existing?.theme ?? "default";
  const templateId = input.templateId ?? existing?.template_id ?? "";
  const draftMediaId = input.draftMediaId ?? existing?.draft_media_id ?? "";
  const draftFingerprint = input.draftFingerprint ?? existing?.draft_fingerprint ?? "";
  db.prepare(
    `INSERT INTO wx_preferences (project_id, theme, template_id, draft_media_id, draft_fingerprint, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       theme = excluded.theme,
       template_id = excluded.template_id,
       draft_media_id = excluded.draft_media_id,
       draft_fingerprint = excluded.draft_fingerprint,
       updated_at = excluded.updated_at`,
  ).run(input.projectId, theme, templateId, draftMediaId, draftFingerprint, timestamp);
  return {
    project_id: input.projectId,
    theme,
    template_id: templateId,
    draft_media_id: draftMediaId,
    draft_fingerprint: draftFingerprint,
    updated_at: timestamp,
  };
}

/* ------------------------------------------------------------------ *
 * 排版模板库
 * ------------------------------------------------------------------ */

/** 列出用户自己的模板，按更新时间倒序。 */
export function listLayoutTemplateRows(): LayoutTemplateRow[] {
  return getDb()
    .prepare("SELECT * FROM layout_templates ORDER BY updated_at DESC, rowid DESC")
    .all() as LayoutTemplateRow[];
}

/** 取一个模板。 */
export function getLayoutTemplateRow(id: string): LayoutTemplateRow | null {
  const row = getDb().prepare("SELECT * FROM layout_templates WHERE id = ?").get(id) as
    | LayoutTemplateRow
    | undefined;
  return row ?? null;
}

/**
 * 写入/更新一个模板。
 *
 * 带了 id 就是更新，没带就是新建。模板本体是一段 JSON，原样存——
 * 解析规则归 layout-template.ts 管，这里不重复实现一遍。
 */
export function saveLayoutTemplateRow(input: {
  id?: string;
  name: string;
  description?: string;
  source: string;
  template: string;
}): LayoutTemplateRow {
  const db = getDb();
  const timestamp = now();
  const existing = input.id ? getLayoutTemplateRow(input.id) : null;
  if (existing) {
    db.prepare(
      "UPDATE layout_templates SET name = ?, description = ?, source = ?, template = ?, updated_at = ? WHERE id = ?",
    ).run(
      input.name,
      input.description ?? existing.description,
      input.source,
      input.template,
      timestamp,
      existing.id,
    );
    return {
      ...existing,
      name: input.name,
      description: input.description ?? existing.description,
      source: input.source,
      template: input.template,
      updated_at: timestamp,
    };
  }
  const row: LayoutTemplateRow = {
    id: input.id ?? createId("lay"),
    name: input.name,
    description: input.description ?? "",
    source: input.source,
    template: input.template,
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.prepare(
    "INSERT INTO layout_templates (id, name, description, source, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.name,
    row.description,
    row.source,
    row.template,
    row.created_at,
    row.updated_at,
  );
  return row;
}

/** 删一个模板。删不存在的返回 false。 */
export function deleteLayoutTemplateRow(id: string): boolean {
  const result = getDb().prepare("DELETE FROM layout_templates WHERE id = ?").run(id);
  return result.changes > 0;
}

/* ------------------------------------------------------------------ *
 * 文案库
 * ------------------------------------------------------------------ */

/**
 * 列文案。category 传了就按分类筛，不传给全量。
 *
 * 列表场景前端只需要标题和分类，content 也一并返回：文案本体通常不大（几千字），
 * 一次取全免去「点开再拉一次」的往返，桌面版本地库也扛得住。
 */
export function listDrafts(options: { category?: string } = {}): DraftRow[] {
  const db = getDb();
  if (options.category) {
    return db
      .prepare("SELECT * FROM drafts WHERE category = ? ORDER BY updated_at DESC, rowid DESC")
      .all(options.category) as DraftRow[];
  }
  return db.prepare("SELECT * FROM drafts ORDER BY updated_at DESC, rowid DESC").all() as DraftRow[];
}

/** 取一条文案。不存在返回 null。 */
export function getDraft(id: string): DraftRow | null {
  const row = getDb().prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow | undefined;
  return row ?? null;
}

/** 新建一条文案。title/content 至少有一个有内容，调用方负责校验。 */
export function createDraft(input: {
  title: string;
  content: string;
  category?: string;
  projectId?: string;
}): DraftRow {
  const db = getDb();
  const timestamp = now();
  const row: DraftRow = {
    id: createId("dft"),
    title: input.title.trim(),
    content: input.content,
    category: input.category?.trim() || "general",
    project_id: input.projectId?.trim() || null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.prepare(
    "INSERT INTO drafts (id, title, content, category, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.title, row.content, row.category, row.project_id, row.created_at, row.updated_at);
  return row;
}

/**
 * 更新一条文案，未传的字段沿用旧值。
 *
 * category / projectId 传空字符串表示「清掉」——分类回到 general、关联稿件置空，
 * 这是前端明确传过来的意图，不能当成「没传」忽略掉。
 */
export function updateDraft(id: string, patch: { title?: string; content?: string; category?: string; projectId?: string | null }): DraftRow | null {
  const db = getDb();
  const existing = getDraft(id);
  if (!existing) return null;
  const next: DraftRow = {
    ...existing,
    title: patch.title !== undefined ? patch.title.trim() : existing.title,
    content: patch.content !== undefined ? patch.content : existing.content,
    category: patch.category !== undefined ? patch.category.trim() || "general" : existing.category,
    project_id: patch.projectId !== undefined ? (patch.projectId?.trim() || null) : existing.project_id,
    updated_at: now(),
  };
  db.prepare(
    "UPDATE drafts SET title = ?, content = ?, category = ?, project_id = ?, updated_at = ? WHERE id = ?",
  ).run(next.title, next.content, next.category, next.project_id, next.updated_at, id);
  return next;
}

/** 删一条文案。删不存在的返回 false。 */
export function deleteDraft(id: string): boolean {
  const result = getDb().prepare("DELETE FROM drafts WHERE id = ?").run(id);
  return result.changes > 0;
}
