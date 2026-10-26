import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  builtinTemplate,
  builtinTemplateId,
  isBuiltinTemplateId,
  normalizeLayoutTemplate,
  themeIdFromBuiltinId,
  type LayoutTemplate,
} from "./layout-template";
import {
  deleteLayoutTemplateRow,
  getLayoutTemplateRow,
  getWxPreference,
  listLayoutTemplateRows,
  saveLayoutTemplateRow,
} from "./repo";
import { layoutPacksDir } from "./paths";
import { normalizeThemeId, type ThemeId } from "./wx-theme";

/**
 * 排版模板的存取。
 *
 * 库里的模板是一段 JSON，渲染要的是 LayoutTemplate 对象，
 * 这一层负责两者之间的转换，顺便把「内置模板」和「用户模板」统一成一种形状——
 * 界面上下拉框里不需要区分它们，用户选的只是一个 id。
 */

/** 把库里的行读成模板对象。 */
function rowToTemplate(row: ReturnType<typeof getLayoutTemplateRow>): LayoutTemplate | null {
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.template);
  } catch {
    // 模板 JSON 坏了不该让整个列表打不开——这一条当没有，用户重存一次就好。
    return null;
  }
  const raw = parsed && typeof parsed === "object" ? (parsed as Partial<LayoutTemplate>) : {};
  return normalizeLayoutTemplate(
    { ...raw, id: row.id, name: row.name, description: row.description, source: "custom" },
    { id: row.id, name: row.name, source: "custom" },
  );
}

/**
 * 随包分发的样式包（内置模板）。
 *
 * 它们是**只读的内置模板**：开箱即用，删不掉，想改就复制一份变成自己的。
 *
 * 为什么要从资源目录读，而不是写死在代码里：
 * 一套主题就是一份 JSON（部件定义 + 色值），写进代码会让源码被几十 KB 的
 * 样式淹没，也没法在不重新编译的情况下加一套新主题——
 * 放一份 JSON 进 resources/layout-packs/ 就够了。
 *
 * 只在服务端读（这个模块只被 API 路由引用），所以用 fs 是安全的。
 */
let builtinPackCache: LayoutTemplate[] | null = null;

function builtinPacks(): LayoutTemplate[] {
  if (builtinPackCache) return builtinPackCache;
  const out: LayoutTemplate[] = [];
  try {
    const dir = layoutPacksDir();
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
          name?: string;
          description?: string;
          vars?: Record<string, string>;
          parts?: unknown;
        };
        // SOURCE.json 是溯源说明，不是样式包——它没有 parts，跳过。
        if (!raw.parts || typeof raw.parts !== "object") continue;
        const slug = file.replace(/\.json$/, "");
        const id = `builtin:${slug}`;
        const normalized = normalizeLayoutTemplate(
          {
            id,
            name: raw.name ?? slug,
            description: raw.description ?? "",
            source: "builtin",
            vars: raw.vars ?? {},
            parts: raw.parts,
          },
          { id, name: raw.name ?? slug, source: "builtin" },
        );
        // 变量表**不补齐**。
        //
        // 补齐是给「用户从零建的模板」用的：勾一个部件、部件 html 里写
        // {{text}}，变量表里没有 text 就填不上。
        // 但随包分发的样式包自带完整的变量表，补齐只会多出一堆
        // 「改了没反应」的色值框（dot1/codeShadow 这些是代码块顶栏用的，
        // 主题里根本没有代码块顶栏）。
        out.push({ ...normalized, vars: { ...(raw.vars ?? {}) } });
      } catch {
        // 某个样式包坏了不该让整个列表打不开——跳过它，其余照常。
      }
    }
  } catch {
    // 资源目录不存在（开发态没跑 prepare-resources）时就没有内置包。
  }
  builtinPackCache = out;
  return out;
}

/**
 * 全部模板：内置三套配色 + 随包分发的样式包在前，用户自己的按更新时间倒序在后。
 */
export function listTemplates(): LayoutTemplate[] {
  const builtins = (["default", "paper", "mist"] as const).map(themeId => builtinTemplate(themeId));
  const packs = builtinPacks();
  const custom = listLayoutTemplateRows()
    .map(rowToTemplate)
    .filter((template): template is LayoutTemplate => template !== null);
  return [...builtins, ...packs, ...custom];
}

/**
 * 按 id 取模板。
 *
 * 内置模板的 id 形如 builtin:paper 或 builtin:rico-wechat-nyt，
 * 前者在代码里生成，后者从资源目录读，都不查库。
 * 找不到就返回 null——调用方要自己决定回退到哪套。
 */
export function getTemplate(id: string | null | undefined): LayoutTemplate | null {
  if (!id) return null;
  if (isBuiltinTemplateId(id)) {
    const themeId = themeIdFromBuiltinId(id);
    if (themeId) return builtinTemplate(themeId);
    return builtinPacks().find(template => template.id === id) ?? null;
  }
  return rowToTemplate(getLayoutTemplateRow(id));
}

/** 存一个模板。带了 id 就是改，没带就是新建。 */
export function saveTemplate(input: {
  id?: string;
  name: string;
  description?: string;
  source?: LayoutTemplate["source"];
  template: LayoutTemplate;
}): LayoutTemplate {
  const normalized = normalizeLayoutTemplate(
    {
      ...input.template,
      name: input.name,
      description: input.description ?? input.template.description,
      source: input.source ?? input.template.source,
    },
    { id: input.id ?? "", name: input.name, source: input.source ?? input.template.source },
  );
  const row = saveLayoutTemplateRow({
    id: input.id,
    name: normalized.name,
    description: normalized.description,
    source: normalized.source,
    template: JSON.stringify(normalized),
  });
  return { ...normalized, id: row.id };
}

/** 删一个模板。内置模板删不掉——它本来就不在库里。 */
export function deleteTemplate(id: string): boolean {
  if (isBuiltinTemplateId(id)) return false;
  return deleteLayoutTemplateRow(id);
}

/**
 * 把一个内置模板复制成用户自己的、可编辑的一份。
 *
 * 「另存为」是固化的起点：内置配色只读，想改颜色就复制一份，
 * 复制出来的那份带全部默认部件，之后每改一处都是自己的。
 */
export function cloneTemplate(source: LayoutTemplate, name: string): LayoutTemplate {
  return {
    ...source,
    id: "",
    name,
    description: source.description,
    source: "custom",
    vars: { ...source.vars },
    parts: source.parts.map(part => ({ ...part })),
  };
}

/** 某个稿件该用哪套排版模板。 */
export type ResolvedTemplate = {
  template: LayoutTemplate;
  /** 模板 id，写回偏好时用。 */
  templateId: string;
  /** 模板是不是内置配色（内置的话要同步写 theme 字段）。 */
  builtin: boolean;
  /** 内置配色对应的 theme 值；用户自己的模板是 null。 */
  theme: ThemeId | null;
};

/**
 * 决定这篇稿子用哪套模板。
 *
 * 优先级：本次请求带的 > 这篇稿子存过的 > 内置默认。
 * 请求同时带 templateId 和 theme 时以 templateId 为准——模板更细，
 * 它自己已经决定用什么颜色了。
 */
export function resolveTemplateForProject(
  projectId: string,
  options: { templateId?: string | null; theme?: string | null } = {},
): ResolvedTemplate {
  const pack = (template: LayoutTemplate): ResolvedTemplate => {
    const themeId = themeIdFromBuiltinId(template.id);
    return {
      template,
      templateId: template.id,
      builtin: themeId !== null,
      theme: themeId,
    };
  };

  if (options.templateId) {
    const found = getTemplate(options.templateId);
    if (found) return pack(found);
  }
  if (options.theme) {
    return pack(builtinTemplate(normalizeThemeId(options.theme)));
  }

  const stored = getWxPreference(projectId);
  if (stored?.template_id) {
    const found = getTemplate(stored.template_id);
    if (found) return pack(found);
  }
  if (stored?.theme) {
    return pack(builtinTemplate(normalizeThemeId(stored.theme)));
  }
  return pack(builtinTemplate("default"));
}

/** 内置配色对应的模板 id。给界面回填用。 */
export function templateIdForTheme(theme: ThemeId): string {
  return builtinTemplateId(theme);
}
