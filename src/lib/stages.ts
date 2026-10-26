/**
 * 阶段定义（纯类型与常量，不依赖任何原生模块）。
 *
 * 单独成文件的原因：客户端组件也要用 STAGES / STAGE_LABELS，
 * 而 db.ts 引的是 better-sqlite3——一旦客户端组件碰到 db.ts，
 * 原生模块就会被拖进浏览器包，构建直接失败。
 */

export type Stage = "brief" | "angle" | "outline" | "article";

export const STAGES: Stage[] = ["brief", "angle", "outline", "article"];

export const STAGE_LABELS: Record<Stage, string> = {
  brief: "材料解读",
  angle: "选题与方向",
  outline: "写作大纲",
  article: "文章正文",
};

export type ProjectRow = {
  id: string;
  title: string;
  topic_id: string;
  stage: Stage;
  created_at: number;
  updated_at: number;
};

export type StageResultRow = {
  id: string;
  project_id: string;
  stage: Stage;
  content: string;
  status: "draft" | "confirmed";
  created_at: number;
  updated_at: number;
};

export type MessageRow = {
  id: string;
  project_id: string;
  stage: Stage;
  role: "user" | "assistant";
  content: string;
  created_at: number;
};

export type EditRow = {
  id: string;
  project_id: string;
  stage: Stage;
  before_text: string;
  after_text: string;
  created_at: number;
};

export type StyleProfileRow = {
  id: string;
  topic_id: string;
  profile: string;
  updated_at: number;
};

export type AssetRow = {
  id: string;
  project_id: string | null;
  kind: "text" | "file" | "image" | "url";
  name: string;
  body: string;
  created_at: number;
};
