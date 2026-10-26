import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "../../../../../../lib/auth";
import { STAGES, type Stage } from "../../../../../../lib/db";
import { loadStageContext } from "../../../../../../lib/stage-context";
import { runStage } from "../../../../../../lib/stage-engine";
import { saveStageResult } from "../../../../../../lib/repo";

export const runtime = "nodejs";
// 生成一篇正文可能要一两分钟，超过默认的 10 秒限制。
export const maxDuration = 300;

const bodySchema = z.object({
  /**
   * 本次输入。
   *
   * **允许为空**：界面上的规矩是「第一次生成不用填」——
   * 稿台拿上一阶段的材料自己往下走，用户看到成品再决定改不改。
   * 空着也能生成，大纲那一步才真的是「自动出一份给我看」。
   *
   * 首道工序（材料解读）例外：没有材料就没有可解读的东西。
   */
  input: z.string().max(200_000),
  /** 本次要启用的技能包。给了就覆盖专题声明的，没给用专题声明的。 */
  skills: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  /**
   * 手填的字数目标（「1000」「800-1200」）。
   *
   * 单独一个参数，是因为输入框里的字不能当篇幅用：
   * 输入往往就是两千多字的原话，里面「大概 2500 字」说的是素材有多长。
   */
  lengthTarget: z.string().trim().max(64).optional(),
});

const patchSchema = z.object({
  content: z.string().max(500_000),
});

/**
 * 跑一个阶段。
 *
 * 只做「生成」，不做「签字」——签字是另一个接口，
 * 因为用户可能生成完先改，改完再签。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; stage: string }> }) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const { id, stage } = await params;
  if (!STAGES.includes(stage as Stage)) {
    return NextResponse.json({ error: "未知的阶段" }, { status: 400 });
  }

  let input: string;
  let skills: string[] | undefined;
  let lengthTarget: string | undefined;
  try {
    const body = bodySchema.parse(await request.json());
    input = body.input;
    skills = body.skills;
    lengthTarget = body.lengthTarget;
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // 首道工序必须有材料：没有材料就没什么可解读的，
  // 让模型自己编一份只会得到一份看起来很像样、但全是空话的东西。
  if (stage === "brief" && !input.trim()) {
    return NextResponse.json({ error: "先把素材写进来——文章、摘抄、聊天记录、数据都行。" }, { status: 400 });
  }

  try {
    const context = await loadStageContext(id);
    if (!context) return NextResponse.json({ error: "稿件不存在" }, { status: 404 });

    const result = await runStage({
      projectId: id,
      stage: stage as Stage,
      userInput: input,
      topicRules: context.topicRules,
      topicName: context.topicName,
      styleProfile: context.styleProfile,
      skills: skills ?? context.skills,
      lengthTarget,
    });

    return NextResponse.json({
      content: result.content,
      stageResult: result.stageResult,
      ...(result.skillWarning ? { skillWarning: result.skillWarning } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.quality ? { quality: result.quality } : {}),
      ...(result.timings ? { timings: result.timings } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * 保存用户改过的草稿。
 *
 * 只存草稿态，不签字——签字是另一件事，用户可能改完还想再让 AI 润一遍。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; stage: string }> }) {
  const unauthorized = await requireAuth();
  if (unauthorized) return unauthorized;

  const { id, stage } = await params;
  if (!STAGES.includes(stage as Stage)) {
    return NextResponse.json({ error: "未知的阶段" }, { status: 400 });
  }

  try {
    const body = patchSchema.parse(await request.json());
    if (!body.content.trim()) {
      return NextResponse.json({ error: "内容是空的，没有可保存的东西。" }, { status: 400 });
    }
    const stageResult = saveStageResult({
      projectId: id,
      stage: stage as Stage,
      content: body.content,
      status: "draft",
    });
    return NextResponse.json({ stageResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
