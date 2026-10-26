import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { localTopicsDir, publicTopicsDir } from "./paths";

/**
 * 专题体系。
 *
 * 一个「专题」是创作者给自己某类内容起的名字，比如「AI 工具深读」「行业观察」。
 * 每个专题自带一套写作规则：读者是谁、语气如何、结构怎么走、什么不能写。
 * 规则会被原样注入到每一道工序的系统提示里，所以它比任何全局设置都更贴近具体这篇稿子。
 *
 * 专题有两层来源：
 * - 公开专题：随安装包分发，用户改不了；
 * - 本地专题：用户在本机新建或覆盖，同 id 时以本地为准。
 *   允许覆盖内置专题是有意的——规则不合口味时，用户应该能改，而不是只能忍受。
 */

export type Topic = {
  id: string;
  name: string;
  description: string;
  audience: string;
  tone: string;
  /** rules.md 全文。 */
  rules: string;
  /** 正文阶段启用的技能包 id。 */
  skills: string[];
  source: "public" | "local";
  /** 是否来自随包分发的公开资源。 */
  builtin: boolean;
};

type Meta = {
  id?: string;
  name?: string;
  description?: string;
  audience?: string;
  tone?: string;
  /** 正文阶段要用的技能包。 */
  skills?: unknown;
};

const rulesCache = new Map<string, { mtimeMs: number; text: string }>();

/** 读 rules.md，按修改时间缓存——用户改了文件要能立刻生效。 */
function readRules(dir: string): string {
  const file = path.join(dir, "rules.md");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return "";
  }
  const cached = rulesCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;
  try {
    const text = readFileSync(file, "utf8");
    rulesCache.set(file, { mtimeMs, text });
    return text;
  } catch {
    return "";
  }
}

/**
 * 归一化专题声明的技能列表。
 *
 * 允许写成字符串或字符串数组，写错类型时按空处理——
 * 专题配置是用户手写的，一个写错不该让整个专题列表挂掉。
 */
function normalizeSkills(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return values
    .map(value => (typeof value === "string" ? value.trim() : ""))
    .filter(value => value.length > 0);
}

function readMeta(dir: string, fallbackId: string): Meta | null {  const file = path.join(dir, "meta.yaml");
  try {
    const parsed = parseYaml(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Meta;
  } catch (error) {
    // 某一个专题的元数据坏了，不该让整份专题列表消失。
    console.warn(`[gaotai] 专题 ${fallbackId} 的 meta.yaml 解析失败，已跳过：`, error instanceof Error ? error.message : error);
    return null;
  }
}

function loadFromDir(root: string, source: "public" | "local"): Topic[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const topics: Topic[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readMeta(dir, entry);
    if (!meta) continue;
    topics.push({
      id: (meta.id ?? entry).trim() || entry,
      name: (meta.name ?? entry).trim() || entry,
      description: (meta.description ?? "").trim(),
      audience: (meta.audience ?? "").trim(),
      tone: (meta.tone ?? "").trim(),
      rules: readRules(dir),
      skills: normalizeSkills(meta.skills),
      source,
      builtin: source === "public",
    });
  }
  return topics;
}

/**
 * 列出全部专题。
 *
 * 顺序：先公开专题，再叠加本地专题；同 id 的本地专题把公开的替换掉。
 */
export async function listTopics(): Promise<Topic[]> {
  const merged = new Map<string, Topic>();
  for (const topic of loadFromDir(publicTopicsDir(), "public")) merged.set(topic.id, topic);
  for (const topic of loadFromDir(localTopicsDir(), "local")) merged.set(topic.id, topic);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** 取一个专题。取不到返回 null。 */
export async function getTopic(id: string): Promise<Topic | null> {
  const key = id.trim();
  if (!key) return null;
  for (const source of ["local", "public"] as const) {
    const root = source === "local" ? localTopicsDir() : publicTopicsDir();
    const hit = loadFromDir(root, source).find(topic => topic.id === key);
    if (hit) return hit;
  }
  return null;
}

/** 取专题规则原文。取不到时返回空串，调用方自行决定要不要降级。 */
export async function resolveTopicRules(id: string): Promise<string> {
  const topic = await getTopic(id);
  return topic?.rules ?? "";
}
