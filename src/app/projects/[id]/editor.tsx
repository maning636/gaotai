"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STAGE_LABELS, type Stage, type StageResultRow, type MessageRow } from "../../../lib/stages";
import { insertMarkdownAt } from "../../../lib/editor-insert";
import { paragraphInsertOffset } from "../../../lib/illustration-plan";
import {
  CHART_KIND_HINTS,
  CHART_KIND_LABELS,
  CHART_KIND_PURPOSES,
  chartSpecSchema,
  type ChartKind,
} from "../../../lib/chart-spec";

/**
 * 稿件编辑器。
 *
 * 界面照着「工序」组织，而不是照着「聊天」组织：
 * 上面一条工序带，四个阶段各占一格；下面左边是对话与输入，右边是这一阶段的产出。
 *
 * 三个动作构成完整闭环：
 *   生成 → 改 → 签字。
 * 改的时候前后文本都会记下来，那是风格画像唯一的证据来源，所以「保存修改」
 * 不只是存盘，它同时把这次修改登记进风格记忆。
 */

export type EditorProject = {  id: string;
  title: string;
  topic_id: string;
  stage: Stage;
};

export type EditorTopic = {
  id: string;
  name: string;
  rules: string;
  /** 专题默认启用的技能包。 */
  skills?: string[];
} | null;

/** 界面上的一个技能包条目。 */
export type EditorSkill = {
  id: string;
  name: string;
  description: string;
  version?: string;
  files: string[];
};

/** 体检结果里的一条。 */
type ProseFinding = {
  level: "fail" | "warn";
  kind: string;
  message: string;
  line?: number;
  excerpt?: string;
};

type ProseResult = {
  hanCount: number;
  summary: Record<string, number>;
  findings: ProseFinding[];
  ok: boolean;
};

/** 全文自动配图计划里的一条（与 /api/illustration/plan 返回一致）。 */
type IllustrationPlanItem = {
  id: string;
  kind: ChartKind;
  title: string;
  afterParagraph: number;
  anchorText: string;
  data: unknown;
  rationale: string;
};

/**
 * 服务端量出来的成稿体检摘要。
 *
 * 与界面上的「查 AI 味」分开：那个按钮量的是当前编辑框里的文字，
 * 这个是生成时服务端量的那一份，字数与硬禁令条数都以此为准。
 *
 * 注意这里只有「读出来给人看」的东西：稿台不替用户改稿，也不替用户补字。
 */
type ArticleQuality = {
  hanCount: number;
  failCount: number;
  warnCount: number;
  missing: number;
  target: { min: number; max: number; source: string; sourceLabel: string; raw: string } | null;
  findings: ProseFinding[];
  /** 大纲要点覆盖：这是「这篇写完了没有」的真正口径。 */
  coverage?: { covered: number; total: number; missing: string[] };
  /** 体检的逐条说明。 */
  notes?: string[];
};

/**
 * 这一阶段各步骤的耗时。
 *
 * 一篇长文要跑十几分钟，界面上只有一个转圈的圈，
 * 用户不知道慢在生成还是慢在补写。把每一步的耗时摊开摆出来，
 * 慢在哪里一眼就看见。
 */
type StageTiming = {
  label: string;
  ms: number;
  calls: number;
};

/** 把毫秒说成一句话。 */
function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/** 把字数目标说成一句话。 */
function targetText(target: { min: number; max: number }): string {
  if (target.min > 0 && target.max > 0) {
    return target.min === target.max ? `${target.min} 字` : `${target.min}–${target.max} 字`;
  }
  if (target.min > 0) return `不少于 ${target.min} 字`;
  return `不超过 ${target.max} 字`;
}

export type ProjectEditorProps = {
  project: EditorProject;
  topic: EditorTopic;
  initialStages: StageResultRow[];
  initialMessages: MessageRow[];
};

type StageState = {
  content: string;
  /** AI 最后一次产出的原文。用来算「改前」。 */
  baseline: string;
  status: "draft" | "confirmed" | "empty";
};

function initialState(stages: StageResultRow[]): Record<Stage, StageState> {
  const state = {} as Record<Stage, StageState>;
  for (const stage of STAGES) {
    const hit = stages.find(item => item.stage === stage);
    state[stage] = {
      content: hit?.content ?? "",
      baseline: hit?.content ?? "",
      status: hit ? hit.status : "empty",
    };
  }
  return state;
}

export function ProjectEditor({
  project,
  topic,
  initialStages,
  initialMessages,
}: ProjectEditorProps) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(project.stage);
  const [state, setState] = useState<Record<Stage, StageState>>(() => initialState(initialStages));
  const [messages, setMessages] = useState<MessageRow[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"" | "generate" | "save" | "confirm" | "prompt" | "prose" | "upload">("");
  /** 正在跑的那次生成的中止器：点「取消」能把它掐断。 */
  const abortRef = useRef<AbortController | null>(null);
  /** 这一轮已经跑了多少秒。模型慢的时候，人得看得见时间在走。 */
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 本机装好的技能包。 */
  const [skillCatalog, setSkillCatalog] = useState<EditorSkill[]>([]);
  /** 本次正文要启用的技能包。默认跟专题声明走。 */
  const [selectedSkills, setSelectedSkills] = useState<string[]>(topic?.skills ?? []);
  /**
   * 手填的字数目标。
   *
   * 空着就按默认篇幅走（公众号是短文，700–1200 字）。
   * 单独一个框，是因为输入框里的字不能当篇幅用——
   * 输入往往就是两千多字的原话，里面「大概 2500 字」说的是素材有多长。
   */
  const [lengthTarget, setLengthTarget] = useState("");
  /** 专题声明的技能集合。切换稿件时用它同步勾选。 */
  const topicSkillKey = (topic?.skills ?? []).join(",");
  /** 技能这一环没生效时的提示。 */
  const [skillWarning, setSkillWarning] = useState("");
  /** 输出被 max_tokens 截断时为 true——稿子是半截的。 */
  const [truncated, setTruncated] = useState(false);
  /** 最近一次成稿体检的结果。 */
  const [prose, setProse] = useState<ProseResult | null>(null);
  /** 插入图片的面板是否展开。 */
  const [showImages, setShowImages] = useState(false);
  /** 生成图解的面板。 */
  const [showIllustration, setShowIllustration] = useState(false);
  const [illustrationKind, setIllustrationKind] = useState<ChartKind>("bar");
  const [illustrationTitle, setIllustrationTitle] = useState("");
  const [illustrationUnit, setIllustrationUnit] = useState("");
  const [illustrationSource, setIllustrationSource] = useState("");
  const [illustrationData, setIllustrationData] = useState("");
  const [illustrationPreview, setIllustrationPreview] = useState<{ url: string; width: number; height: number } | null>(null);
  const [illustrationBusy, setIllustrationBusy] = useState(false);
  const [illustrationError, setIllustrationError] = useState("");
  /** 六种图型的真实缩略图（data URL），进面板时拉一次。 */
  const [chartSamples, setChartSamples] = useState<Record<string, string> | null>(null);
  /** 图解面板的二级切换：手动制图 / 全文自动配图。 */
  const [illustrationMode, setIllustrationMode] = useState<"manual" | "auto">("manual");
  /** 自动配图：分析中的状态。 */
  const [autoPlanBusy, setAutoPlanBusy] = useState(false);
  const [autoPlanError, setAutoPlanError] = useState("");
  /** 自动配图：计划清单与每条的勾选状态。 */
  const [autoPlan, setAutoPlan] = useState<IllustrationPlanItem[]>([]);
  const [autoPlanSelected, setAutoPlanSelected] = useState<Record<string, boolean>>({});
  /** 自动配图：生成并插入的进行状态与汇总。 */
  const [autoInsertBusy, setAutoInsertBusy] = useState(false);
  const [autoInsertResult, setAutoInsertResult] = useState<{ ok: number; fail: number; messages: string[] } | null>(null);
  /** 自动配图：返回的 warnings 与正文长度。 */
  const [autoWarnings, setAutoWarnings] = useState<string[]>([]);
  const [autoArticleLength, setAutoArticleLength] = useState(0);
  const [autoHasNumbers, setAutoHasNumbers] = useState(true);
  /** 素材库里已有的图片。 */
  const [library, setLibrary] = useState<{ path: string; url: string; size: number }[]>([]);
  /** 选本机图片用的隐藏 input。 */
  const imagePicker = useRef<HTMLInputElement>(null);
  /** 当前阶段正文编辑框：插图要按光标位置落，而不是永远拼到末尾。 */
  const contentRef = useRef<HTMLTextAreaElement>(null);
  /** 最后一次已知的光标位置。点工具栏按钮会让编辑框失焦，但位置要留住。 */
  const contentCaret = useRef<number | null>(null);
  /** 生成时服务端量出来的成稿体检摘要。 */
  const [quality, setQuality] = useState<ArticleQuality | null>(null);
  /** 这一阶段各步骤的耗时。 */
  const [timings, setTimings] = useState<StageTiming[]>([]);

  // 技能包清单是本机资源，装一次就不变了，进页面时拉一次就够。
  useEffect(() => {
    let alive = true;
    fetch("/api/skills", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("读取技能包失败"))))
      .then((body: { skills?: EditorSkill[] }) => {
        if (alive) setSkillCatalog(Array.isArray(body.skills) ? body.skills : []);
      })
      .catch(() => {
        if (alive) setSkillCatalog([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 换了稿件、专题声明的技能不一样时，勾选跟着走。
  // 用拼出来的字符串当依赖，而不是数组本身——数组每次渲染都是新引用，
  // 用它当依赖会把用户手动改过的勾选一次又一次冲掉。
  useEffect(() => {
    setSelectedSkills(topicSkillKey ? topicSkillKey.split(",").filter(Boolean) : []);
  }, [topicSkillKey]);

  const stageMessages = useMemo(
    () => messages.filter(message => message.stage === stage),
    [messages, stage],
  );
  const current = state[stage];
  const dirty = current.content !== current.baseline;

  useEffect(() => {
    contentCaret.current = null;
  }, [stage]);

  function updateStageContent(value: string) {
    setState(currentState => ({ ...currentState, [stage]: { ...currentState[stage], content: value } }));
  }

  async function call(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? "请求失败。");
    }
    return response;
  }

  /**
   * 取消正在跑的这一阶段。
   *
   * 模型慢的时候，界面只有一句「生成中…」的话，人是没法判断它是卡了还是在跑，
   * 只能干等或者刷新——刷新一次，前面那几分钟就白费了。
   * 所以这里给一条退路：不等了。
   *
   * 取消是**前端的**：中止对接口的等待。服务端那一轮还会跑完（LLM 调用停不下来），
   * 但结果不会再写进界面——用户已经走开了。
   */
  function onCancelGenerate() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy("");
    setNotice("已取消这次生成。");
  }

  async function onGenerate() {
    if (busy) return;
    const text = input.trim();
    // 第一次生成可以空着——稿台拿上一阶段的材料自己往下走。
    // 追问不行：追问是给模型的指令，没内容就没东西可说。
    if (!text && current.content) {
      setError("想改哪里？说得具体一点。");
      return;
    }
    setBusy("generate");
    setError("");
    setNotice("");
    setSkillWarning("");
    setTruncated(false);
    setQuality(null);
    setTimings([]);
    // 起一个中止器，并且让秒表开始走。
    const controller = new AbortController();
    abortRef.current = controller;
    setElapsed(0);
    const ticker = setInterval(() => setElapsed(value => value + 1), 1000);
    try {
      // 技能包在「材料解读」和「正文」两个阶段可用：
      // 前者管「怎么总结两千多字的原话」，后者管「怎么写」。
      // 勾选框全取消时也要把空数组发上去——「这次不用技能包」和
      // 「没说过用不用」不是一回事，不发就等于还是专题声明的那一套。
      const payload: { input: string; skills?: string[]; lengthTarget?: string } = { input: text };
      if (stage === "article" || stage === "brief") {
        payload.skills = selectedSkills;
      }
      if (lengthTarget.trim()) {
        payload.lengthTarget = lengthTarget.trim();
      }
      const response = await call(`/api/projects/${project.id}/stages/${stage}`, {
        method: "POST",
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json();
      if (body.skillWarning) setSkillWarning(body.skillWarning);
      // 输出被额度截断时稿子是半截的，但文字连贯、看不出异常，必须单独提醒。
      setTruncated(body.finishReason === "length");
      // 服务端在交稿前已经量过一遍：字数和硬禁令条数照它显示。
      if (body.quality) {
        setQuality(body.quality as ArticleQuality);
        setProse({
          hanCount: body.quality.hanCount,
          summary: {},
          findings: body.quality.findings ?? [],
          ok: body.quality.failCount === 0,
        });
      }
      // 各步骤的耗时：慢在哪里直接摆出来。
      setTimings(Array.isArray(body.timings) ? (body.timings as StageTiming[]) : []);
      setState(currentState => ({
        ...currentState,
        [stage]: { content: body.content, baseline: body.content, status: "draft" },
      }));
      setMessages(current => [
        ...current,
        {
          id: `local-u-${Date.now()}`,
          project_id: project.id,
          stage,
          role: "user",
          content: text,
          created_at: Date.now(),
        },
        {
          id: `local-a-${Date.now()}`,
          project_id: project.id,
          stage,
          role: "assistant",
          content: body.content,
          created_at: Date.now(),
        },
      ]);
      setInput("");
      setNotice("已生成。可以直接改，改完再签字。");
    } catch (issue) {
      // 取消不是错误：中止之后 fetch 会抛 AbortError，不该弹一条红色的报错。
      if (issue instanceof DOMException && issue.name === "AbortError") {
        setNotice("已取消这次生成。");
      } else {
        setError(issue instanceof Error ? issue.message : "生成失败。");
      }
    } finally {
      clearInterval(ticker);
      abortRef.current = null;
      setBusy("");
      setElapsed(0);
    }
  }

  async function onSaveEdit() {
    if (busy) return;
    if (!current.content.trim()) {
      setError("这一阶段还没有内容，先生成或者直接写点什么。");
      return;
    }
    setBusy("save");
    setError("");
    setNotice("");
    try {
      // 先存草稿，再登记这次修改——顺序反了会出现「记了修改但内容没存下」。
      await call(`/api/projects/${project.id}/stages/${stage}`, {
        method: "PATCH",
        body: JSON.stringify({ content: current.content }),
      });
      if (dirty) {
        await call(`/api/projects/${project.id}/stages/${stage}/edit`, {
          method: "POST",
          body: JSON.stringify({ before: current.baseline, after: current.content }),
        });
      }
      setState(currentState => ({
        ...currentState,
        [stage]: {
          ...currentState[stage],
          baseline: currentState[stage].content,
          // 保存之后这一阶段就不再是「未开始」了，标签要跟着变。
          status: currentState[stage].status === "confirmed" ? "confirmed" : "draft",
        },
      }));
      setNotice(dirty ? "已保存，这次修改也记进风格素材了。" : "已保存。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "保存失败。");
    } finally {
      setBusy("");
    }
  }

  async function onConfirm() {
    if (busy) return;
    setBusy("confirm");
    setError("");
    setNotice("");
    try {
      if (dirty) {
        await call(`/api/projects/${project.id}/stages/${stage}`, {
          method: "PATCH",
          body: JSON.stringify({ content: current.content }),
        });
        await call(`/api/projects/${project.id}/stages/${stage}/edit`, {
          method: "POST",
          body: JSON.stringify({ before: current.baseline, after: current.content }),
        });
      }
      const response = await call(`/api/projects/${project.id}/stages/${stage}/confirm`, {
        method: "POST",
        body: JSON.stringify({ content: current.content }),
      });
      const body = await response.json();
      setState(currentState => ({
        ...currentState,
        [stage]: { ...currentState[stage], status: "confirmed" },
      }));
      if (body.nextStage) {
        setStage(body.nextStage);
        setNotice(`已签字，进入「${body.nextStageLabel}」。`);
      } else {
        setNotice("已签字。这一篇到最后一道工序了，排版操作在「去排版预览」里。");
      }
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "确认失败。");
    } finally {
      setBusy("");
    }
  }

  /** 把界面上的文本解析成 ChartSpec；格式不对就返回错误。 */
  function parseIllustrationSpec(): { spec?: unknown; error?: string } {
    const title = illustrationTitle.trim();
    if (!title) return { error: "先写一个标题。" };
    const lines = illustrationData
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (!lines.length) return { error: "数据还没填。" };

    const meta = {
      title,
      ...(illustrationUnit.trim() ? { unit: illustrationUnit.trim() } : {}),
      ...(illustrationSource.trim() ? { source: illustrationSource.trim() } : {}),
    };

    try {
      let spec: unknown;
      if (illustrationKind === "bar" || illustrationKind === "waffle") {
        const rows = lines.map(line => {
          const [label, raw] = line.split(/[,\t]/).map(part => part.trim());
          const value = Number(raw);
          if (!label || !raw || !Number.isFinite(value)) throw new Error(`这一行不对：${line}`);
          return { label, value };
        });
        spec =
          illustrationKind === "bar"
            ? { kind: "bar", ...meta, rows }
            : { kind: "waffle", ...meta, segments: rows };
      } else if (illustrationKind === "timeline") {
        spec = {
          kind: "timeline",
          ...meta,
          items: lines.map(line => {
            const [date, heading, detail] = line.split("|").map(part => part.trim());
            if (!date || !heading) throw new Error(`这一行不对：${line}`);
            return { date, title: heading, ...(detail ? { detail } : {}) };
          }),
        };
      } else if (illustrationKind === "steps") {
        spec = {
          kind: "steps",
          ...meta,
          steps: lines.map(line => {
            const [heading, detail] = line.split("|").map(part => part.trim());
            if (!heading) throw new Error(`这一行不对：${line}`);
            return { title: heading, ...(detail ? { detail } : {}) };
          }),
        };
      } else if (illustrationKind === "kpi") {
        spec = {
          kind: "kpi",
          ...meta,
          items: lines.map(line => {
            const [label, value, delta] = line.split(/[,\t]/).map(part => part.trim());
            if (!label || !value) throw new Error(`这一行不对：${line}`);
            return { label, value, ...(delta ? { delta } : {}) };
          }),
        };
      } else {
        const sep = lines.findIndex(line => line === "---");
        if (sep < 1 || sep === lines.length - 1) {
          throw new Error("前后对比要用一行 --- 隔开左右两栏。");
        }
        const left = lines.slice(0, sep);
        const right = lines.slice(sep + 1);
        if (left.length < 2 || right.length < 2) {
          throw new Error("左右两栏都要有「标题 + 至少一条要点」。");
        }
        spec = {
          kind: "compare",
          ...meta,
          left: { label: left[0], points: left.slice(1) },
          right: { label: right[0], points: right.slice(1) },
        };
      }

      const parsed = chartSpecSchema.safeParse(spec);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: `${issue?.path?.join(".") ?? ""} ${issue?.message ?? "参数不对"}`.trim() };
      }
      return { spec: parsed.data };
    } catch (issue) {
      return { error: issue instanceof Error ? issue.message : "数据格式不对。" };
    }
  }

  async function onGenerateIllustration() {
    if (illustrationBusy) return;
    const parsed = parseIllustrationSpec();
    if (!parsed.spec) {
      setIllustrationError(parsed.error ?? "数据格式不对。");
      return;
    }
    setIllustrationBusy(true);
    setIllustrationError("");
    try {
      const response = await fetch("/api/illustration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.spec),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "生成图解失败。");
      setIllustrationPreview({ url: body.url, width: body.width, height: body.height });
    } catch (issue) {
      setIllustrationError(issue instanceof Error ? issue.message : "生成图解失败。");
    } finally {
      setIllustrationBusy(false);
    }
  }

  function onInsertIllustration() {
    if (!illustrationPreview) return;
    insertImage(illustrationPreview.url, "图解");
    setIllustrationPreview(null);
    setShowIllustration(false);
  }

  /**
   * 全文自动配图：调服务端分析正文，返回配图计划。
   *
   * 分析不落盘、不插正文，只把清单交回界面；用户勾选后由「生成并插入」统一执行。
   */
  async function onAnalyzeIllustration() {
    if (autoPlanBusy) return;
    setAutoPlanBusy(true);
    setAutoPlanError("");
    setAutoInsertResult(null);
    setAutoWarnings([]);
    setAutoPlan([]);
    setAutoPlanSelected({});
    try {
      const response = await fetch("/api/illustration/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "分析全文失败。");
      const plan = Array.isArray(body.plan) ? body.plan : [];
      setAutoPlan(plan);
      setAutoPlanSelected(Object.fromEntries(plan.map((item: IllustrationPlanItem) => [item.id, true])));
      setAutoWarnings(Array.isArray(body.warnings) ? body.warnings : []);
      setAutoArticleLength(typeof body.articleLength === "number" ? body.articleLength : 0);
      setAutoHasNumbers(body.hasNumbers !== false);
    } catch (issue) {
      setAutoPlanError(issue instanceof Error ? issue.message : "分析全文失败。");
    } finally {
      setAutoPlanBusy(false);
    }
  }

  /** 勾选 / 取消一条计划。 */
  function onTogglePlanItem(id: string) {
    setAutoPlanSelected(current => ({ ...current, [id]: !current[id] }));
  }

  /** 编辑一条计划的 data（可展开文本框）。 */
  function onEditPlanData(id: string, value: string) {
    setAutoPlan(current => current.map(item => (item.id === id ? { ...item, data: value } : item)));
  }

  /** 计划条目当前的 data 文本（展开编辑用）。 */
  function planDataText(item: IllustrationPlanItem): string {
    if (typeof item.data === "string") return item.data;
    try {
      return JSON.stringify(item.data, null, 2);
    } catch {
      return String(item.data);
    }
  }

  /** 从编辑后的 data 文本重新解析出 ChartSpec；解析失败返回错误。 */
  function parsePlanData(item: IllustrationPlanItem): { spec?: unknown; error?: string } {
    const raw = item.data;
    if (typeof raw !== "string") {
      const parsed = chartSpecSchema.safeParse(raw);
      return parsed.success ? { spec: parsed.data } : { error: "这份数据不是合法的图解数据。" };
    }
    try {
      const json = JSON.parse(raw) as unknown;
      const parsed = chartSpecSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { error: `${issue?.path?.join(".") ?? ""} ${issue?.message ?? "数据不对"}`.trim() };
      }
      return { spec: parsed.data };
    } catch {
      return { error: "编辑后的数据不是合法 JSON。" };
    }
  }

  /**
   * 生成并插入已选的图。
   *
   * 逐条渲染 PNG（复用现有出图接口），按 afterParagraph 定位插入正文对应段落之后，
   * 不把图全塞在末尾。任一条失败不影响其他条，最后汇总「成功 N 张、失败 M 张」。
   */
  async function onGenerateAutoIllustration() {
    if (autoInsertBusy) return;
    const selected = autoPlan.filter(item => autoPlanSelected[item.id]);
    if (!selected.length) {
      setAutoPlanError("还没有勾选任何一条。");
      return;
    }
    setAutoInsertBusy(true);
    setAutoInsertResult(null);
    setAutoPlanError("");
    const ok: string[] = [];
    const fail: { title: string; reason: string }[] = [];
    let content = current.content;

    try {
      for (const item of selected) {
        const parsed = parsePlanData(item);
        if (!parsed.spec) {
          fail.push({ title: item.title, reason: parsed.error ?? "数据不对" });
          continue;
        }
        try {
          const response = await fetch("/api/illustration", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed.spec),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error ?? "生成图解失败。");
          const snippet = `![${item.title}](${body.url})`;
          const offset = paragraphInsertOffset(content, item.afterParagraph);
          const { content: next } = insertMarkdownAt(content, offset, snippet);
          content = next;
          ok.push(item.title);
        } catch (issue) {
          fail.push({ title: item.title, reason: issue instanceof Error ? issue.message : "生成失败" });
        }
      }

      if (ok.length) {
        setState(currentState => ({
          ...currentState,
          article: { ...currentState.article, content },
        }));
        contentCaret.current = null;
        setNotice(`已生成 ${ok.length} 张图并插入正文${fail.length ? `，${fail.length} 张失败` : ""}。记得点「保存修改」存下来。`);
      }
      setAutoInsertResult({
        ok: ok.length,
        fail: fail.length,
        messages: [
          ...ok.map(title => `✓ ${title}`),
          ...fail.map(item => `✗ ${item.title}：${item.reason}`),
        ],
      });
      setAutoPlan([]);
      setAutoPlanSelected({});
    } finally {
      setAutoInsertBusy(false);
    }
  }

  /**
   * 把一张图插进正文的光标位置。
   *
   * 图是外面来的（别的工具生图、截图、照片），先传进本机素材库，
   * 正文里引用它的本机地址；推草稿时稿台会逐张换成微信自己的地址。
   *
   * 位置来自 contentCaret：点工具栏按钮会让编辑框失焦，但最后一次
   * 光标位置要留住；从没点过编辑框才退回末尾。
   */
  function insertImage(url: string, alt: string) {
    const snippet = `![${alt}](${url})`;
    const base = state.article?.content ?? "";
    const { content, caret } = insertMarkdownAt(base, contentCaret.current, snippet);

    setState(currentState => ({
      ...currentState,
      article: { ...currentState.article, content },
    }));
    contentCaret.current = caret;
    requestAnimationFrame(() => {
      const el = contentRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
    setNotice("图已插到光标位置。");
  }

  /** 拉素材库列表。 */
  const loadLibrary = useCallback(async () => {
    try {
      const response = await fetch("/api/files", { cache: "no-store" });
      const body = await response.json();
      if (response.ok && Array.isArray(body)) setLibrary(body);
    } catch {
      // 素材库读不到就不显示这一块，不打断别的操作。
    }
  }, []);

  useEffect(() => {
    if (showImages) void loadLibrary();
  }, [showImages, loadLibrary]);

  /** 六种图型的缩略图：进面板时拉一次，失败就降级为纯文字卡片。 */
  useEffect(() => {
    if (!showIllustration || chartSamples) return;
    let alive = true;
    fetch("/api/illustration/samples", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("读取图解样例失败"))))
      .then((body: { samples?: Record<string, string> }) => {
        if (alive && body.samples) setChartSamples(body.samples);
      })
      .catch(() => {
        // 缩略图挂了不拦着手动制图：卡片降级成纯文字。
      });
    return () => {
      alive = false;
    };
  }, [showIllustration, chartSamples]);

  /** 从本机传图并插进正文。 */
  async function onUploadImage(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setBusy("upload");
    setError("");
    try {
      // 并行上传所有图片：不再逐张串行等待，多张一起传，总耗时只看最慢那张。
      const uploadResults = await Promise.all(
        files.map(async (file) => {
          const form = new FormData();
          form.append("file", file);
          const response = await fetch("/api/files", { method: "POST", body: form });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? `「${file.name}」上传失败。`);
          return body.image?.url as string | undefined;
        }),
      );
      const urls = uploadResults.filter((url): url is string => Boolean(url));
      // 批量插入：在本地累积内容与光标，最后一次性写回。
      // 不能逐张 setState——insertImage 读的是渲染闭包里的 state，
      // 循环里第二次起会拿到旧内容，前面的图会被覆盖。
      let content = state.article?.content ?? "";
      let caret = contentCaret.current;
      for (const url of urls) {
        const snippet = `![配图](${url})`;
        const result = insertMarkdownAt(content, caret, snippet);
        content = result.content;
        caret = result.caret;
      }
      if (urls.length) {
        setState(currentState => ({
          ...currentState,
          article: { ...currentState.article, content },
        }));
        contentCaret.current = caret;
        requestAnimationFrame(() => {
          const el = contentRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(caret ?? 0, caret ?? 0);
        });
      }
      await loadLibrary();
      setNotice(`已上传 ${files.length} 张图片并插入正文。`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "上传失败。");
    } finally {
      setBusy("");
      if (imagePicker.current) imagePicker.current.value = "";
    }
  }

  /**
   * 成稿体检。
   *
   * 只报警不改文：结果分成「必须修改」和「需要人工判断」两档，
   * 每一档都带行号，改起来不用自己找。
   */
  async function onProseCheck() {
    if (busy) return;
    if (!current.content.trim()) {
      setError("这一阶段还没有内容，先生成或者写点什么再体检。");
      return;
    }
    setBusy("prose");
    setError("");
    setNotice("");
    try {
      const response = await call("/api/prose-check", {
        method: "POST",
        body: JSON.stringify({ content: current.content }),
      });
      const body = (await response.json()) as ProseResult;
      setProse(body);
      const fails = body.findings.filter(item => item.level === "fail").length;
      const warns = body.findings.filter(item => item.level === "warn").length;
      // 手动量的是当前编辑框里的文字，比生成时那一份新。
      // 摘要跟着一起换掉，别让两组数字并排出现。
      setQuality(current => {
        if (!current) return current;
        const min = current.target ? current.target.min : 0;
        return {
          ...current,
          hanCount: body.hanCount,
          failCount: fails,
          warnCount: warns,
          findings: body.findings,
          missing: min > 0 ? Math.max(0, min - body.hanCount) : 0,
        };
      });
      setNotice(
        body.findings.length
          ? `体检完成：必须修改 ${fails} 条，需要人工判断 ${warns} 条。`
          : "体检完成：没查出问题。",
      );
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "体检失败。");
    } finally {
      setBusy("");
    }
  }

  async function onCopy() {    try {
      await navigator.clipboard.writeText(current.content);
      setNotice("正文已复制。");
    } catch {
      setError("复制失败，请手动选中复制。");
    }
  }

  /**
   * 能不能点「开始这一阶段」。
   *
   * **空着也能生成**——这是这一版的改动重点。
   *
   * 以前的规矩是「必须先打字才能生成」，于是每一道工序都逼着用户先说点什么：
   * 大纲那一步本来该是「自动出一份给我看，不满意再改」，结果变成
   * 「先写一句不痛不痒的话，它才肯给我大纲」。
   *
   * 所以规则改成：**第一次生成不用填**（稿台拿上一阶段的材料自己往下走），
   * **追问才必须填**（那是给模型的指令，没内容就没东西可说）。
   */
  const isFollowUp = Boolean(current.content);
  const canGenerate = !busy && (!isFollowUp || input.trim().length > 0);

  /**
   * 这是不是一篇「导入进来的文章」。
   *
   * 判据：**正文已签字，而前面三道工序一道都没做**。
   * 正常流程走到正文时，材料解读、选题、大纲都签过了；只有导入的文章会这样。
   *
   * 认出来是为了不说让人迷路的话——工序带上三格「未开始」，
   * 用户会以为自己做错了什么。其实那三道工序对一篇现成的文章没有意义。
   */
  const isImported = useMemo(
    () =>
      state.article.status === "confirmed" &&
      state.brief.status === "empty" &&
      state.angle.status === "empty" &&
      state.outline.status === "empty",
    [state],
  );

  return (
    <div className="gt-stack gt-stack--lg">
      {/* 工序带 */}
      <div className="gt-steps">
        {STAGES.map((item, index) => {
          const itemState = state[item];
          const classes = ["gt-step"];
          if (itemState.status === "confirmed") classes.push("gt-step--done");
          else if (item === stage) classes.push("gt-step--active");
          else if (itemState.status === "empty") classes.push("gt-step--locked");
          return (
            <button
              key={item}
              type="button"
              className={classes.join(" ")}
              onClick={() => {
                setStage(item);
                setNotice("");
                setError("");
                setSkillWarning("");
              }}
              style={{ cursor: "pointer", textAlign: "left" }}
            >
              <span className="gt-step__num">{index + 1}</span>
              <span>
                <span className="gt-step__label">{STAGE_LABELS[item]}</span>
                <span className="gt-step__meta">
                  {itemState.status === "confirmed"
                    ? "已签字"
                    : itemState.status === "draft"
                      ? "草稿"
                      : isImported && item !== "article"
                        ? "已跳过"
                        : "未开始"}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}
      {isImported ? (
        <div className="gt-alert">
          <strong>这是导入进来的文章</strong>，前面三道工序对它没有意义，直接跳过了。
          要改内容在右边改；要重新走一遍工序，点工序带上的对应那一格。
          想发到公众号，去「公众号」页选这一篇、配好封面就能推草稿箱。
        </div>
      ) : null}
      {skillWarning ? <div className="gt-alert gt-alert--warn">{skillWarning}</div> : null}
      {truncated ? (
        <div className="gt-alert gt-alert--warn">
          这一稿是半截的：输出达到了模型的长度上限就被截断了。可以直接改，也可以换个模型再生成一次。
        </div>
      ) : null}

      <div className="gt-grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.15fr)" }}>
        {/* 左：对话与输入 */}
        <div className="gt-stack">
          <section className="gt-panel gt-panel--flat">
            <div className="gt-panel__head">
              <h2 className="gt-panel__title">这一阶段的往来</h2>
              <span className="gt-small gt-muted">{stageMessages.length} 条</span>
            </div>
            <div className="gt-stack gt-stack--sm gt-scroll" style={{ maxHeight: "380px" }}>
              {stageMessages.length === 0 ? (
                <p className="gt-small gt-muted" style={{ margin: 0 }}>
                  还没有对话。把你手上的素材贴进下面的框子。
                </p>
              ) : (
                stageMessages.map(message => (
                  <div
                    key={message.id}
                    className="gt-panel gt-panel--sunken"
                    style={{ padding: "10px 12px" }}
                  >
                    <div className="gt-eyebrow" style={{ marginBottom: "4px" }}>
                      {message.role === "user" ? "你" : "AI"}
                    </div>
                    <div className="gt-small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {message.content}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="gt-panel gt-panel--flat">
            <label className="gt-field">
              <span className="gt-label">丢素材，或者问一句</span>
              <textarea
                className="gt-textarea"
                value={input}
                onChange={event => setInput(event.target.value)}
                placeholder={
                  stage === "brief"
                    ? "把文章、链接摘抄、聊天记录、数据都贴进来，越完整越好。"
                    : isFollowUp
                      ? "想改哪里？说得具体一点：「第二段太虚，换成那个真实案例」。"
                      : "可以不填——直接点右边，稿台会按上一阶段的材料自动往下走。"
                }
                style={{ minHeight: "150px" }}
              />
            </label>
            {stage === "angle" || stage === "outline" || stage === "article" ? (
              <label className="gt-field" style={{ marginTop: "10px" }}>
                <span className="gt-label">目标字数（留空就按默认 700–1200 字）</span>
                <input
                  className="gt-input"
                  value={lengthTarget}
                  onChange={event => setLengthTarget(event.target.value)}
                  placeholder="例如 1000，或 800-1200"
                />
              </label>
            ) : null}
            <div className="gt-row gt-row--between" style={{ marginTop: "10px" }}>
              {busy === "generate" ? (
                <>
                  <span className="gt-hint">
                    正在跑这一阶段，已经 <strong>{elapsed}</strong> 秒。模型慢的时候可以先去忙别的。
                  </span>
                  <button className="gt-btn gt-btn--sm" type="button" onClick={onCancelGenerate}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <span className="gt-hint">生成需要一点时间，模型慢的时候别重复点。</span>
                  <button className="gt-btn gt-btn--primary" type="button" onClick={onGenerate} disabled={!canGenerate}>
                    {current.content ? "追问 / 重写" : "开始这一阶段"}
                  </button>
                </>
              )}
            </div>
          </section>

          {topic ? (
            <section className="gt-panel gt-panel--flat gt-panel--accent">
              <div className="gt-eyebrow">当前专题</div>
              <strong>{topic.name}</strong>
              <p className="gt-small gt-muted" style={{ margin: "4px 0 0" }}>
                这一阶段的写作规则来自这个专题，它会跟着每一道工序一起进提示词。
              </p>
            </section>
          ) : null}

          {stage === "article" || stage === "brief" ? (
            <section className="gt-panel gt-panel--flat">
              <div className="gt-panel__head">
                <h2 className="gt-panel__title">技能包</h2>
                <span className="gt-small gt-muted">
                  {selectedSkills.length ? `已选 ${selectedSkills.length} 个` : "未启用"}
                </span>
              </div>
              {skillCatalog.length === 0 ? (
                <p className="gt-small gt-muted" style={{ margin: 0 }}>
                  本机没有装好的技能包。{stage === "brief" ? "材料照样会读" : "正文会照常写"}，只是没有额外的方法可循。
                </p>
              ) : (
                <div className="gt-stack gt-stack--sm">
                  {skillCatalog.map(skill => {
                    const checked = selectedSkills.includes(skill.id);
                    return (
                      <label
                        key={skill.id}
                        className="gt-panel gt-panel--sunken"
                        style={{ display: "block", padding: "10px 12px", cursor: "pointer" }}
                      >
                        <span className="gt-row" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={event => {
                              setSelectedSkills(current =>
                                event.target.checked
                                  ? [...current, skill.id]
                                  : current.filter(item => item !== skill.id),
                              );
                            }}
                            style={{ marginTop: "3px" }}
                          />
                          <span style={{ minWidth: 0 }}>
                            <span className="gt-row" style={{ gap: "6px" }}>
                              <strong>{skill.name}</strong>
                              {skill.id !== skill.name ? <span className="gt-tag">{skill.id}</span> : null}
                              {skill.version ? <span className="gt-tag gt-tag--green">v{skill.version}</span> : null}
                            </span>
                            <span
                              className="gt-small gt-muted"
                              title={skill.description}
                              style={{
                                display: "-webkit-box",
                                WebkitLineClamp: 4,
                                WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                                marginTop: "2px",
                              }}
                            >
                              {skill.description}
                            </span>
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="gt-hint" style={{ marginTop: "8px" }}>
                {stage === "brief"
                  ? "材料解读阶段也认技能包：素材有两三千字的时候，「怎么总结、总结成什么样」交给它管。"
                  : "技能包按需读取：只把入口告诉模型，它自己决定读哪几份参考。上面这份默认选中的是专题声明的技能。"}
              </p>
            </section>
          ) : null}
        </div>

        {/* 右：产出 */}
        <div className="gt-stack">
          <section className="gt-editor">
            <div className="gt-editor__head">
              <h2 className="gt-panel__title" style={{ margin: 0 }}>
                {STAGE_LABELS[stage]}·产出
              </h2>
              <div className="gt-row" style={{ gap: "8px" }}>
                <span className={`gt-tag ${current.status === "confirmed" ? "gt-tag--green" : "gt-tag--yellow"}`}>
                  {current.status === "confirmed" ? "已签字" : current.status === "draft" ? "草稿" : "未开始"}
                </span>
                {dirty ? <span className="gt-tag gt-tag--pink">有未保存的改动</span> : null}
                {timings.length ? (
                  <span
                    className="gt-tag gt-tag--blue"
                    title={timings
                      .map(item => `${item.label} ${durationText(item.ms)}（${item.calls} 次请求）`)
                      .join("\n")}
                  >
                    用了 {durationText(timings.reduce((sum, item) => sum + item.ms, 0))}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="gt-editor__body">
              <textarea
                ref={contentRef}
                className="gt-editor__text"
                value={current.content}
                onChange={event => updateStageContent(event.target.value)}
                onSelect={event => {
                  contentCaret.current = event.currentTarget.selectionStart;
                }}
                onClick={event => {
                  contentCaret.current = event.currentTarget.selectionStart;
                }}
                onKeyUp={event => {
                  contentCaret.current = event.currentTarget.selectionStart;
                }}
                placeholder="这一阶段的产出会显示在这里。生成之后可以随意改。"
              />
            </div>
            <div className="gt-editor__foot">
              <button className="gt-btn gt-btn--sm" type="button" onClick={onSaveEdit} disabled={busy !== ""}>
                {busy === "save" ? "保存中…" : "保存修改"}
              </button>
              <button
                className="gt-btn gt-btn--sm gt-btn--primary"
                type="button"
                onClick={onConfirm}
                disabled={busy !== "" || !current.content.trim()}
              >
                {busy === "confirm" ? "确认中…" : "签字确认"}
              </button>
              <button className="gt-btn gt-btn--sm" type="button" onClick={onCopy} disabled={!current.content}>
                复制
              </button>
              {stage === "article" ? (
                <button
                  className="gt-btn gt-btn--sm"
                  type="button"
                  onClick={() => setShowImages(value => !value)}
                  disabled={busy !== ""}
                >
                  {showImages ? "收起配图" : "插入图片"}
                </button>
              ) : null}
              {stage === "article" ? (
                <button
                  className="gt-btn gt-btn--sm"
                  type="button"
                  onClick={() => setShowIllustration(value => !value)}
                  disabled={busy !== ""}
                >
                  {showIllustration ? "收起图解" : "生成图解"}
                </button>
              ) : null}
              <button className="gt-btn gt-btn--sm" type="button" onClick={onProseCheck} disabled={busy !== "" || !current.content.trim()}>
                {busy === "prose" ? "体检中…" : "查 AI 味"}
              </button>
              {stage === "article" && current.status === "confirmed" ? (
                <>
                  <span className="gt-spacer" />
                  <span className="gt-small gt-muted">正文定稿，排版操作挪到了独立页面。</span>
                  <button
                    className="gt-btn gt-btn--sm gt-btn--blue"
                    type="button"
                    onClick={() => router.push(`/projects/${encodeURIComponent(project.id)}/preview`)}
                  >
                    去排版预览
                  </button>
                </>
              ) : null}
            </div>
          </section>

          {stage === "article" && showImages ? (
            <section className="gt-panel gt-panel--flat">
              <div className="gt-panel__head">
                <h3 className="gt-panel__title">插入图片</h3>
                <span className="gt-small gt-muted">
                  图从外面来：别的工具生图、截图、照片都可以。传进来后正文引用它，推草稿时会换成微信的地址。
                </span>
              </div>
              <div className="gt-stack gt-stack--sm">
                <input
                  ref={imagePicker}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  style={{ display: "none" }}
                  onChange={onUploadImage}
                />
                <div className="gt-row" style={{ gap: "8px" }}>
                  <button
                    className="gt-btn gt-btn--primary gt-btn--sm"
                    type="button"
                    onClick={() => imagePicker.current?.click()}
                    disabled={busy !== ""}
                  >
                    {busy === "upload" ? "上传中…" : "从本机传图并插入"}
                  </button>
                  <span className="gt-small gt-muted">
                    或者从素材库里选一张：
                  </span>
                </div>
                {library.length ? (
                  <div className="gt-grid gt-grid--4">
                    {library.map(image => (
                      <button
                        key={image.path}
                        type="button"
                        className="gt-panel gt-panel--flat"
                        style={{ padding: "6px", cursor: "pointer", textAlign: "left" }}
                        title={image.path}
                        onClick={() => insertImage(image.url, "配图")}
                      >
                        <img
                          src={image.url}
                          alt={image.path}
                          style={{
                            width: "100%",
                            aspectRatio: "3 / 2",
                            objectFit: "contain",
                            background: "#fff",
                            display: "block",
                          }}
                        />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="gt-small gt-muted" style={{ margin: 0 }}>
                    素材库还是空的——先传一张。
                  </p>
                )}
              </div>
            </section>
          ) : null}

          {stage === "article" && showIllustration ? (
            <section className="gt-panel gt-panel--flat">
              <div className="gt-panel__head">
                <h3 className="gt-panel__title">生成图解</h3>
                <span className="gt-small gt-muted">
                  选一种图、填数据，生成 PNG 后按光标插入正文；或者让稿台通读全文、自动决定配几张图、配在哪。
                </span>
              </div>

              {/* 二级切换：手动制图 / 全文自动配图 */}
              <div className="gt-row" style={{ gap: "6px", marginBottom: "12px" }}>
                <button
                  type="button"
                  className={`gt-btn gt-btn--sm${illustrationMode === "manual" ? " gt-btn--primary" : ""}`}
                  onClick={() => {
                    setIllustrationMode("manual");
                    setAutoPlanError("");
                  }}
                >
                  手动制图
                </button>
                <button
                  type="button"
                  className={`gt-btn gt-btn--sm${illustrationMode === "auto" ? " gt-btn--primary" : ""}`}
                  onClick={() => {
                    setIllustrationMode("auto");
                    setIllustrationError("");
                  }}
                >
                  全文自动配图
                </button>
              </div>

              {illustrationMode === "manual" ? (
                <div className="gt-stack gt-stack--sm">
                  {/* 六种图的图例卡片网格：缩略图 + 中文名 + 一句用途 */}
                  <div className="gt-chart-grid">
                    {(Object.keys(CHART_KIND_LABELS) as ChartKind[]).map(kind => (
                      <button
                        key={kind}
                        type="button"
                        className={`gt-chart-card${illustrationKind === kind ? " gt-chart-card--active" : ""}`}
                        onClick={() => {
                          setIllustrationKind(kind);
                          setIllustrationPreview(null);
                          setIllustrationError("");
                        }}
                      >
                        <span className="gt-chart-card__thumb">
                          {chartSamples?.[kind] ? (
                            <img
                              src={chartSamples[kind]}
                              alt={CHART_KIND_LABELS[kind]}
                              loading="lazy"
                            />
                          ) : (
                            <span className="gt-chart-card__placeholder">{CHART_KIND_LABELS[kind]}</span>
                          )}
                        </span>
                        <span className="gt-chart-card__name">{CHART_KIND_LABELS[kind]}</span>
                        <span className="gt-chart-card__purpose">{CHART_KIND_PURPOSES[kind]}</span>
                      </button>
                    ))}
                  </div>

                  <label className="gt-field">
                    <span className="gt-label">标题</span>
                    <input
                      className="gt-input"
                      value={illustrationTitle}
                      onChange={event => setIllustrationTitle(event.target.value)}
                      placeholder="一句话说清这张图"
                    />
                  </label>

                  <div className="gt-row" style={{ gap: "8px" }}>
                    <label className="gt-field" style={{ flex: 1 }}>
                      <span className="gt-label">单位（可选）</span>
                      <input
                        className="gt-input"
                        value={illustrationUnit}
                        onChange={event => setIllustrationUnit(event.target.value)}
                        placeholder="分钟 / 篇 / %"
                      />
                    </label>
                    <label className="gt-field" style={{ flex: 1 }}>
                      <span className="gt-label">来源（可选）</span>
                      <input
                        className="gt-input"
                        value={illustrationSource}
                        onChange={event => setIllustrationSource(event.target.value)}
                        placeholder="2026-10 内部统计"
                      />
                    </label>
                  </div>

                  <label className="gt-field">
                    <span className="gt-label">数据</span>
                    <textarea
                      className="gt-textarea gt-textarea--mono"
                      rows={6}
                      value={illustrationData}
                      onChange={event => setIllustrationData(event.target.value)}
                      placeholder={CHART_KIND_HINTS[illustrationKind]}
                    />
                  </label>

                  {illustrationError ? <div className="gt-alert gt-alert--error">{illustrationError}</div> : null}

                  <div className="gt-row">
                    <button
                      className="gt-btn gt-btn--primary"
                      type="button"
                      onClick={() => void onGenerateIllustration()}
                      disabled={illustrationBusy}
                    >
                      {illustrationBusy ? "生成中…" : "生成预览"}
                    </button>
                    {illustrationPreview ? (
                      <button className="gt-btn" type="button" onClick={onInsertIllustration}>
                        插入到光标
                      </button>
                    ) : null}
                  </div>

                  {illustrationPreview ? (
                    <img
                      src={illustrationPreview.url}
                      alt="图解预览"
                      style={{ width: "100%", border: "2px solid #1A1A1A", background: "#fff" }}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="gt-stack gt-stack--sm">
                  <div className="gt-row" style={{ gap: "8px" }}>
                    <button
                      className="gt-btn gt-btn--primary"
                      type="button"
                      onClick={() => void onAnalyzeIllustration()}
                      disabled={autoPlanBusy}
                    >
                      {autoPlanBusy ? "正在通读全文…" : "分析全文"}
                    </button>
                    <span className="gt-small gt-muted">
                      稿台通读正文，自动决定配几张图、配在什么位置、做什么样的图。
                    </span>
                  </div>

                  {autoArticleLength > 0 ? (
                    <p className="gt-small gt-muted" style={{ margin: 0 }}>
                      正文 {autoArticleLength} 字{autoHasNumbers ? "" : "，没有数字——只配结构类图（时间线 / 步骤 / 对比）"}。
                    </p>
                  ) : null}

                  {autoPlanError ? <div className="gt-alert gt-alert--error">{autoPlanError}</div> : null}

                  {autoPlan.length ? (
                    <>
                      <div className="gt-stack gt-stack--sm">
                        {autoPlan.map(item => (
                          <div key={item.id} className="gt-chart-plan-card">
                            <label className="gt-chart-plan-card__head">
                              <input
                                type="checkbox"
                                checked={Boolean(autoPlanSelected[item.id])}
                                onChange={() => onTogglePlanItem(item.id)}
                              />
                              <span className="gt-chart-plan-card__kind">{CHART_KIND_LABELS[item.kind]}</span>
                              <span className="gt-chart-plan-card__title">{item.title}</span>
                            </label>
                            <p className="gt-chart-plan-card__where">
                              插在第 {item.afterParagraph} 段之后：{item.anchorText || "（段落在文末）"}
                            </p>
                            <p className="gt-chart-plan-card__why">为什么这里要图：{item.rationale}</p>
                            <details className="gt-chart-plan-card__data">
                              <summary>编辑数据</summary>
                              <textarea
                                className="gt-textarea gt-textarea--mono"
                                rows={4}
                                value={planDataText(item)}
                                onChange={event => onEditPlanData(item.id, event.target.value)}
                              />
                            </details>
                          </div>
                        ))}
                      </div>

                      <div className="gt-row">
                        <button
                          className="gt-btn gt-btn--primary"
                          type="button"
                          onClick={() => void onGenerateAutoIllustration()}
                          disabled={autoInsertBusy}
                        >
                          {autoInsertBusy
                            ? "生成并插入中…"
                            : `生成并插入已选（${autoPlan.filter(item => autoPlanSelected[item.id]).length} 张）`}
                        </button>
                      </div>
                    </>
                  ) : null}

                  {autoWarnings.length ? (
                    <div className="gt-alert gt-alert--warn">
                      {autoWarnings.map((warning, index) => (
                        <div key={index}>{warning}</div>
                      ))}
                    </div>
                  ) : null}

                  {autoInsertResult ? (
                    <div className="gt-alert gt-alert--info">
                      <div>
                        成功 {autoInsertResult.ok} 张、失败 {autoInsertResult.fail} 张。
                      </div>
                      {autoInsertResult.messages.map((message, index) => (
                        <div key={index}>{message}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          ) : null}

          {dirty ? (
            <section className="gt-panel gt-panel--flat">
              <div className="gt-panel__head">
                <h3 className="gt-panel__title">这次改了什么</h3>
                <span className="gt-small gt-muted">保存后会计入风格素材</span>
              </div>
              <div className="gt-diff">
                <div className="gt-diff__col">
                  <div className="gt-diff__label">改前</div>
                  <div className="gt-diff__text gt-diff__text--before">{current.baseline || "（空）"}</div>
                </div>
                <div className="gt-diff__col">
                  <div className="gt-diff__label">改后</div>
                  <div className="gt-diff__text gt-diff__text--after">{current.content || "（空）"}</div>
                </div>
              </div>
            </section>
          ) : null}

          {prose ? (
            <section className="gt-panel gt-panel--flat">
              <div className="gt-panel__head">
                <h3 className="gt-panel__title">成稿体检</h3>
                <span className="gt-small gt-muted">{prose.hanCount} 字</span>
              </div>
              {quality ? (
                <div className="gt-row" style={{ gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                  {quality.coverage ? (
                    <span className="gt-tag gt-tag--blue">
                      大纲要点 {quality.coverage.covered} / {quality.coverage.total} 段落地
                    </span>
                  ) : null}
                  <span className="gt-tag">必须修改 {quality.failCount} 条</span>
                  <span className="gt-tag">需人工判断 {quality.warnCount} 条</span>
                  {quality.target ? (
                    <span className="gt-tag gt-tag--blue">
                      参考篇幅 {targetText(quality.target)}（{quality.target.sourceLabel}）
                    </span>
                  ) : (
                    <span className="gt-tag">未设字数目标</span>
                  )}
                </div>
              ) : null}
              {timings.length ? (
                <p className="gt-small gt-muted" style={{ margin: "0 0 10px" }}>
                  这一稿花了{" "}
                  {durationText(timings.reduce((sum, item) => sum + item.ms, 0))}：
                  {timings
                    .map(item => `${item.label} ${durationText(item.ms)}（${item.calls} 次请求）`)
                    .join("，")}
                  。
                </p>
              ) : null}
              {prose.findings.length === 0 ? (
                <p className="gt-small gt-muted" style={{ margin: 0 }}>
                  没查出问题：硬禁令清零，也没有明显的模型腔。
                </p>
              ) : (
                <div className="gt-stack gt-stack--sm">
                  {(["fail", "warn"] as const).map(level => {
                    const items = prose.findings.filter(item => item.level === level);
                    if (!items.length) return null;
                    return (
                      <div key={level}>
                        <div className="gt-eyebrow">
                          {level === "fail" ? "必须修改" : "需要人工判断"}（{items.length}）
                        </div>
                        <ul className="gt-small" style={{ margin: "4px 0 0", paddingLeft: "18px" }}>
                          {items.map((item, index) => (
                            <li key={index} style={{ marginBottom: "2px" }}>
                              {item.line ? `第 ${item.line} 行：` : ""}
                              {item.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
              {quality && quality.notes && quality.notes.length ? (
                <ul className="gt-small gt-muted" style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
                  {quality.notes.map((note, index) => (
                    <li key={index} style={{ marginBottom: "2px" }}>
                      {note}
                    </li>
                  ))}
                </ul>
              ) : null}
              {quality && quality.coverage && quality.coverage.missing.length ? (
                <p className="gt-hint" style={{ marginTop: "8px", marginBottom: 0 }}>
                  大纲里有 {quality.coverage.missing.length} 段没在正文里落地：
                  {quality.coverage.missing.join("、")}。对照大纲看看这几段是不是漏了，
                  漏了就补进去——这一版没有自动补写。
                </p>
              ) : null}
              {quality && quality.missing > 0 ? (
                <p className="gt-small gt-muted" style={{ marginTop: "8px", marginBottom: 0 }}>
                  比参考篇幅的下限少 {quality.missing} 字。短不是错——
                  材料撑不起就写短，写短是合法的；想要更长，直接说要补哪一块。
                </p>
              ) : null}
              <p className="gt-hint" style={{ marginTop: "8px" }}>
                体检只报警，不替你改。稿台不自动重写、不自动补字：
                怎么改由你定，改完把「保存修改」按下去。
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
