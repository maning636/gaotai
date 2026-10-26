import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dataStorageDir } from "./paths";
import type {
  AssetRow,
  EditRow,
  MessageRow,
  ProjectRow,
  Stage,
  StageResultRow,
  StyleProfileRow,
} from "./stages";

/**
 * 本地数据层。
 *
 * 一篇稿子 = 一个 project；每个阶段有一份产出（stage_results）；
 * 阶段里的往返对话记在 messages；用户对 AI 产出做的每次人工修改记在 edits，
 * 它是风格画像的唯一证据来源——没有真实修改，就提炼不出风格。
 *
 * 数据库文件放在用户数据目录下，桌面版与开发版互不干扰。
 *
 * 阶段定义与行类型放在 stages.ts：那是纯类型文件，客户端组件也能引；
 * 本文件引的是 better-sqlite3，客户端组件一旦碰它就会把原生模块拖进浏览器包。
 */

export type {
  AssetRow,
  EditRow,
  MessageRow,
  ProjectRow,
  Stage,
  StageResultRow,
  StyleProfileRow,
} from "./stages";
export { STAGES, STAGE_LABELS } from "./stages";

let db: Database.Database | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  topic_id    TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT 'brief',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_results (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_results_project ON stage_results(project_id, stage);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, stage, created_at);

CREATE TABLE IF NOT EXISTS edits (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  before_text TEXT NOT NULL,
  after_text  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edits_project ON edits(project_id, stage);

CREATE TABLE IF NOT EXISTS style_profiles (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT NOT NULL UNIQUE,
  profile     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);

-- 公众号侧的排版偏好与草稿状态，按稿件一对一。
-- 单独成表而不是塞进 projects：projects 是稿件本体，这里存的是「推上去了没有、
-- 推成什么样子」这类渠道侧状态，生命周期和稿件解耦；删稿件靠外键级联清掉。
-- draft_fingerprint 记录上次推送内容的摘要，用它判断「内容没变，不用重推」，
-- 免得用户连点两次，草稿箱里就多躺一份同样的稿子。
-- template_id 指向排版模板库里的模板；空字符串表示还在用内置配色。
CREATE TABLE IF NOT EXISTS wx_preferences (
  project_id       TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  theme            TEXT NOT NULL DEFAULT 'default',
  template_id      TEXT NOT NULL DEFAULT '',
  draft_media_id   TEXT NOT NULL DEFAULT '',
  draft_fingerprint TEXT NOT NULL DEFAULT '',
  updated_at       INTEGER NOT NULL
);

-- 排版模板库。
-- 样式包导入后裁剪、固化的结果存在这里：一份模板就是一组「部件」的定义。
-- 内置的三套配色不在表里——它们是代码里的 builtin 模板，只读；
-- 表里只存用户自己的、可以反复改的那些。
CREATE TABLE IF NOT EXISTS layout_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'custom',
  template    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

/**
 * 补列。
 *
 * CREATE TABLE IF NOT EXISTS 只管新表，老库升级时缺的列不会自己长出来。
 * 所以这里显式查一遍列名，缺哪个补哪个——加字段只要动两处：
 * SCHEMA 里的建表语句，和这张补列表。
 */
function migrate(db: Database.Database) {
  const columns = db.prepare("PRAGMA table_info(wx_preferences)").all() as { name: string }[];
  if (!columns.some(column => column.name === "template_id")) {
    db.exec("ALTER TABLE wx_preferences ADD COLUMN template_id TEXT NOT NULL DEFAULT ''");
  }
}

export function getDb(): Database.Database {
  if (db) return db;
  const dir = dataStorageDir();
  mkdirSync(dir, { recursive: true });
  db = new Database(path.join(dir, "gaotai.sqlite"));
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 关闭连接（测试与进程退出时用）。 */
export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}

export function now() {
  return Date.now();
}
