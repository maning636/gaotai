import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { ChatTool } from "./llm";
import { skillsDir } from "./paths";

/**
 * 本地技能包。
 *
 * 技能包是随安装包分发的只读资源，目录约定：
 *
 *   skills/<技能名>/SKILL.md          入口，含 YAML 头（name / description）
 *   skills/<技能名>/references/*.md   参考文件，由 SKILL.md 自己指路
 *
 * 为什么要「读」而不是「塞」：一份完整的写作技能动辄上万字，
 * 全部塞进提示词既贵又会稀释注意力。正确做法是只把入口告诉模型，
 * 让它自己按需读需要的那几份——这也是技能包这种形态的意义。
 *
 * 安全约定（与文件服务层一致）：
 * - 只接受相对路径，拒绝绝对路径、.. 段、反斜杠、控制字符；
 * - 逻辑路径与真实路径各校验一次，符号链接不能把读取带出技能目录；
 * - 只能读到本次启用的技能，读别的技能直接拒绝；
 * - 工具不联网、不执行脚本，只读文本。
 */

const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillMetadata = {
  /** 技能 id，等于目录名。 */
  id: string;
  /** 展示名，取自 YAML 头的 name。 */
  name: string;
  /** 一句话说明这个技能管什么。 */
  description: string;
  /** 版本号，可选。 */
  version?: string;
  /** 入口文件位置，形如 `human-writing/SKILL.md`。 */
  location: string;
};

export type SkillFile = {
  /** 相对技能根目录的路径。 */
  file: string;
  /** 文件正文。 */
  content: string;
};

export type SkillCatalog = {
  /** 本次启用的技能。 */
  skills: SkillMetadata[];
  /** 交给模型的工具定义。 */
  tool: ChatTool;
  /** 本次实际读到过入口文件的技能 id。 */
  loaded: Set<string>;
  /** 读一个技能文件。模型真正读过的入口会记进 loaded。 */
  read: (file: string) => Promise<SkillFile>;
  /**
   * 断言本次真的加载过入口。
   *
   * 文件躺在磁盘上不等于这次用了它——模型可能压根没调工具，
   * 那这次正文就不是按技能写的，不该当成合格产出存下来。
   */
  assertActivated: () => void;
};

/** 解析 SKILL.md 顶部的 YAML 头。 */
function parseFrontmatter(text: string): Record<string, unknown> {
  const hit = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!hit) return {};
  try {
    const parsed = parse(hit[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** target 是否在 base 之内。 */
function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * 校验路径形状，只接受干净的相对路径。
 *
 * 绝对路径、带 .. 的路径、控制字符一律先毙掉——顺序很重要：
 * 如果先查「这个技能启用了吗」，一个绝对路径会被报成「技能 C: 未在本次启用」，
 * 既误导使用者，又让真正该报的错（路径不合法）永远不出现。
 */
function validateRelative(relative: string): string {
  if (!relative || relative.includes("\0") || /[\n\r]/.test(relative)) {
    throw new Error("技能文件路径无效。");
  }
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
    throw new Error("技能文件路径必须是相对于技能根目录的相对路径。");
  }
  const normalized = path.normalize(relative);
  if (normalized.split(path.sep).some(segment => segment === "..")) {
    throw new Error("技能文件路径不能包含 .. 段。");
  }
  return normalized;
}

/**
 * 把相对路径解到磁盘上的真实文件。
 *
 * 两道校验：先看逻辑路径在不在技能根目录内，再看真实路径在不在内——
 * 只做前者的话，一个指向目录外的符号链接就能把读取带出去。
 */
async function resolveInside(root: string, relative: string): Promise<string> {
  const normalized = validateRelative(relative);
  const target = path.resolve(root, normalized);
  if (!isInside(root, target)) {
    throw new Error("技能文件路径必须位于技能目录内。");
  }
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    throw new Error(`技能文件不存在：${normalized}`);
  }
  if (!isInside(root, resolved)) {
    throw new Error("技能文件不能通过符号链接越过技能目录。");
  }
  return resolved;
}

/** 列出技能根目录下的所有技能 id。 */
export async function listSkillIds(): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir(), { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** 递归列出技能目录里的文本文件（相对技能根目录）。 */
async function listFilesIn(root: string, dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFilesIn(root, full, out);
    } else if (entry.isFile()) {
      const rel = path.relative(root, full).split(path.sep).join("/");
      out.push(rel);
    }
  }
  return out;
}

export type InstalledSkill = SkillMetadata & {
  /** 技能包里的文件清单。 */
  files: string[];
};

/**
 * 列出本机装好的全部技能。
 *
 * 坏掉的技能包（缺 SKILL.md、头写错）不拖垮整个列表——
 * 界面要能显示「有哪些技能」，而不是因为一个坏包就什么都看不到。
 */
export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  const ids = await listSkillIds();
  const result: InstalledSkill[] = [];
  for (const id of ids) {
    try {
      const catalog = await openSkills([id]);
      const skill = catalog.skills[0];
      const root = await realpath(skillsDir());
      const files = await listFilesIn(root, path.join(root, id));
      result.push({ ...skill, files: files.sort() });
    } catch (error) {
      console.warn(
        `[gaotai] 技能包 ${id} 读取失败，已跳过：`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result;
}

/**
 * 打开一组技能。
 *
 * 传入的 id 必须都在本机装好；缺一个就报错，不静默跳过——
 * 静默跳过会让「技能没生效」变成一件没人知道的事。
 */
export async function openSkills(ids: string[]): Promise<SkillCatalog> {
  const root = await realpath(skillsDir());
  const wanted = [...new Set(ids.map(id => id.trim()).filter(Boolean))];

  const skills = await Promise.all(
    wanted.map(async id => {
      if (!SKILL_ID_PATTERN.test(id)) {
        throw new Error(`技能 id 不合法：${id}`);
      }
      const location = `${id}/SKILL.md`;
      const text = await readFile(await resolveInside(root, location), "utf8");
      const meta = parseFrontmatter(text);
      const name = typeof meta.name === "string" ? meta.name : "";
      const description = typeof meta.description === "string" ? meta.description.trim() : "";
      if (!name) throw new Error(`技能 ${id} 的 SKILL.md 缺少 name。`);
      if (!description) throw new Error(`技能 ${id} 的 SKILL.md 缺少 description。`);
      if (name !== id) throw new Error(`技能 name（${name}）与目录名（${id}）不一致。`);
      const version = typeof meta.version === "string" ? meta.version : undefined;
      return { id, name, description, ...(version ? { version } : {}), location } satisfies SkillMetadata;
    }),
  );

  const enabled = new Set(skills.map(skill => skill.id));
  const loaded = new Set<string>();

  const read = async (file: string): Promise<SkillFile> => {
    // 先验路径形状，再谈启用与否：错也要报对原因。
    const normalized = validateRelative(file);
    const id = normalized.split(path.sep)[0];
    if (!enabled.has(id)) {
      throw new Error(`技能 ${id} 未在本次启用，读不到。`);
    }
    const abs = await resolveInside(root, normalized);
    const content = await readFile(abs, "utf8");
    if (!content.trim()) throw new Error(`技能文件是空的：${normalized}`);
    if (path.basename(normalized) === "SKILL.md" && path.dirname(normalized) === id) {
      loaded.add(id);
    }
    return { file: normalized.split(path.sep).join("/"), content };
  };

  const tool: ChatTool = {
    type: "function",
    function: {
      name: "read_skill_file",
      description:
        "读取本机技能包里的一份文件。先读下面列出的 SKILL.md，看清它指向哪些参考文件，再按需读那些 references。" +
        "路径相对于技能根目录，例如 human-writing/SKILL.md。此工具不联网、不执行脚本，只读本地文本。",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "相对于技能根目录的文件路径，例如 human-writing/SKILL.md",
          },
        },
        required: ["file"],
      },
    },
  };
  return {
    skills,
    tool,
    loaded,
    read,
    assertActivated() {
      for (const skill of skills) {
        if (!loaded.has(skill.id)) {
          throw new Error(`这次没有真正读过 ${skill.id}/SKILL.md，正文没有按技能要求写，请重试。`);
        }
      }
    },
  };
}

/** 把技能清单写成给模型看的一段说明。 */
export function renderSkillCatalog(catalog: SkillCatalog): string {
  if (!catalog.skills.length) return "";
  const lines = catalog.skills.map(skill => {
    const version = skill.version ? `（v${skill.version}）` : "";
    return `- ${skill.id}${version}：${skill.description}\n  入口：${skill.location}`;
  });
  return [
    "本次可用的技能包：",
    ...lines,
    "",
    "需要写正文之外的专门做法时，用 read_skill_file 读入口文件，看清它指向哪些参考文件，再按需读那几份。",
    "不要一次把所有参考文件都读进来，读当前任务真正命中的那几份。",
    "",
    "技能文件里如果提到运行某个脚本来做检查，稿台没有脚本执行通道，请改用 check_prose 工具做同一件事。",
  ].join("\n");
}
