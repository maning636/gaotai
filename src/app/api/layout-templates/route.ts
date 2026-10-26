import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../lib/auth";
import { deleteTemplate, listTemplates, saveTemplate } from "../../../lib/layout-store";
import { normalizeLayoutTemplate, type LayoutTemplate } from "../../../lib/layout-template";

export const runtime = "nodejs";

/**
 * 排版模板库。
 *
 * 读：内置三套配色 + 用户自己的模板，统一成一种形状返回，
 *     界面的下拉框不需要关心哪个是内置哪个是自建。
 * 写：新建或改一个模板。改的时候带 id 就是改，不带就是新建。
 * 删：只删得了用户自己的；内置配色是代码里的，删不掉。
 *
 * 模板本身是一段 JSON（部件定义 + 色值），这里原样存，
 * 解析与清洗规则统一在 layout-template.ts 里，不在接口层再实现一遍。
 */

const templateSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).optional(),
  source: z.enum(["builtin", "imported", "custom"]).optional(),
  template: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(["builtin", "imported", "custom"]).optional(),
    vars: z.record(z.string(), z.string()).optional(),
    parts: z.unknown().optional(),
  }),
});

export async function GET() {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  try {
    return NextResponse.json({ templates: listTemplates() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取模板失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  try {
    const body = templateSchema.parse(await request.json());
    const template = normalizeLayoutTemplate(body.template, {
      id: body.id ?? "",
      name: body.name,
      source: body.source ?? "custom",
    });
    const saved = saveTemplate({
      id: body.id,
      name: body.name,
      description: body.description,
      source: body.source ?? template.source,
      template,
    });
    return NextResponse.json({ template: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存模板失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  try {
    const ok = deleteTemplate(id);
    if (!ok) return NextResponse.json({ error: "这套模板删不掉。" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除模板失败" },
      { status: 500 },
    );
  }
}

export type LayoutTemplateListItem = LayoutTemplate;
