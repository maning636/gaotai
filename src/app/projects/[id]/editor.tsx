"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STAGES, STAGE_LABELS, type Stage, type StageResultRow, type MessageRow } from "../../../lib/stages";
import { normalizeThemeId } from "../../../lib/wx-theme";

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

/** 界面上的一个排版模板条目。 */
export type EditorTemplate = {
  id: string;
  name: string;
  description?: string;
  source: "builtin" | "imported" | "custom";
};

export type EditorProject = {
  id: string;
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
  /** 这篇稿子记住的公众号排版主题（内置配色）。 */
  wxTheme?: string;
  /** 这篇稿子记住的排版模板。 */
  wxTemplateId?: string;
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
  wxTheme,
  wxTemplateId,
}: ProjectEditorProps) {
  const [stage, setStage] = useState<Stage>(project.stage);
  const [state, setState] = useState<Record<Stage, StageState>>(() => initialState(initialStages));
  const [messages, setMessages] = useState<MessageRow[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"" | "generate" | "save" | "confirm" | "preview" | "prompt" | "prose" | "copy" | "upload">("");
  /** 正在跑的那次生成的中止器：点「取消」能把它掐断。 */
  const abortRef = useRef<AbortController | null>(null);
  /** 这一轮已经跑了多少秒。模型慢的时候，人得看得见时间在走。 */
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState("");
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
  /** 素材库里已有的图片。 */
  const [library, setLibrary] = useState<{ path: string; url: string; size: number }[]>([]);
  /** 选本机图片用的隐藏 input。 */
  const imagePicker = useRef<HTMLInputElement>(null);
  /** 生成时服务端量出来的成稿体检摘要。 */
  const [quality, setQuality] = useState<ArticleQuality | null>(null);
  /**
   * 公众号排版模板。
   *
   * 内置配色是三套只读的模板，用户自己固化的模板也在同一张清单里。
   * 每次预览或推草稿都会把它记回这篇稿子的偏好。
   */
  const [templates, setTemplates] = useState<EditorTemplate[]>([]);
  const [templateId, setTemplateId] = useState(wxTemplateId || `builtin:${normalizeThemeId(wxTheme)}`);
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

  // 排版模板清单：内置配色 + 用户自己固化的模板。进页面时拉一次。
  useEffect(() => {
    let alive = true;
    fetch("/api/layout-templates", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("读取模板失败"))))
      .then((body: { templates?: EditorTemplate[] }) => {
        if (!alive) return;
        const list = Array.isArray(body.templates) ? body.templates : [];
        setTemplates(list);
        // 记着的那套模板要是被删了，回退到内置默认，别让下拉框空着。
        if (list.length && !list.some(item => item.id === templateId)) {
          setTemplateId(list[0].id);
        }
      })
      .catch(() => {
        if (alive) setTemplates([]);
      });
    return () => {
      alive = false;
    };
    // 只在进页面时拉一次：这里读到的是初始那份 templateId，
    // 之后用户换模板走的是 onTemplateChange，不该被这里冲掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setNotice("已签字。这一篇到最后一道工序了，可以推去公众号。");
      }
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "确认失败。");
    } finally {
      setBusy("");
    }
  }

  /**
   * 拉一份排版好的正文回来。
   *
   * 带上当前选的模板：服务端会顺手把它记成这篇稿子的偏好，
   * 下次打开还是这套排版，推草稿时也按它渲染。
   */
  async function loadPreview(id: string) {
    const response = await fetch(
      `/api/wechat/preview?projectId=${project.id}&templateId=${encodeURIComponent(id)}`,
      { cache: "no-store" },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "预览失败。");
    return body as { html?: string; text?: string };
  }

  async function onPreview() {
    if (busy) return;
    setBusy("preview");
    setError("");
    try {
      const body = await loadPreview(templateId);
      setPreview(body.html ?? "");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "预览失败。");
    } finally {
      setBusy("");
    }
  }

  /**
   * 换排版模板。
   *
   * 预览开着的时候跟着换——排版改了就该立刻看到效果，
   * 不然用户得再点一次预览才知道换没换。
   * 同时把新模板记成这篇稿子的偏好，推草稿时不用再选。
   */
  async function onTemplateChange(next: string) {
    setTemplateId(next);
    setError("");
    try {
      await fetch("/api/wechat/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, templateId: next }),
      });
    } catch {
      // 记偏好失败不该拦住换模板：预览本身才是用户要的。
    }
    if (!preview) return;
    try {
      const body = await loadPreview(next);
      setPreview(body.html ?? "");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "换排版失败。");
    }
  }

  /**
   * 复制排版正文。
   *
   * 剪贴板里同时写两份：html（带行内样式）和纯文本。
   * 贴进公众号编辑器走 html 那份，贴进纯文本编辑器走文本那份——
   * 只写一份的话，用户换个地方粘贴就变成一堆标签。
   */
  async function onCopyFormatted() {
    if (busy) return;
    setBusy("copy");
    setError("");
    setNotice("");
    try {
      const body = await loadPreview(templateId);
      const html = String(body.html ?? "");
      const text = String(body.text ?? "");
      if (!html) throw new Error("这篇稿子还没有正文。");

      // 先写纯文本：这一步各浏览器都支持，作为兜底。
      await navigator.clipboard.writeText(text);
      // html 那份要用 ClipboardItem 单独写一次。
      // 浏览器不给写 html 格式的权限时，纯文本那份已经在剪贴板里了。
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([html], { type: "text/html" }),
              "text/plain": new Blob([text], { type: "text/plain" }),
            }),
          ]);
        } catch {
          // 忽略：纯文本那份已经复制成功了。
        }
      }
      setNotice("排版正文已复制（html + 纯文本两种格式）。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "复制失败，请手动选中复制。");
    } finally {
      setBusy("");
    }
  }

  async function onImagePrompt() {
    if (busy) return;
    setBusy("prompt");
    setError("");
    try {
      const response = await call("/api/image-prompts", {
        method: "POST",
        body: JSON.stringify({ title: project.title, article: current.content }),
      });
      const body = await response.json();
      setNotice(`配图提示词：${body.prompt}`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "生成配图提示词失败。");
    } finally {
      setBusy("");
    }
  }

  /**
   * 把一张图插进**正文阶段**的末尾。
   *
   * 图是外面来的（别的工具生图、截图、照片），先传进本机素材库，
   * 正文里引用它的本机地址；推草稿时稿台会逐张换成微信自己的地址。
   *
   * 插的是正文阶段而不是「当前阶段」：配图是给成稿用的。
   */
  function insertImage(url: string, alt: string) {
    setState(currentState => {
      const target = currentState.article;
      const base = (target?.content ?? "").trimEnd();
      const next = `${base}${base ? "\n\n" : ""}![${alt}](${url})\n`;
      return { ...currentState, article: { ...target, content: next } };
    });
    setNotice(
      stage === "article"
        ? "图已经插到正文末尾。记得点「保存修改」把它存下来。"
        : "图已经插到正文阶段。切到「正文」那一步就能看到，记得点「保存修改」。",
    );
    setShowImages(false);
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

  /** 从本机传图并插进正文。 */
  async function onUploadImage(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setBusy("upload");
    setError("");
    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/files", { method: "POST", body: form });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `「${file.name}」上传失败。`);
        const url = body.image?.url as string | undefined;
        if (url) insertImage(url, "配图");
      }
      await loadLibrary();
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
                setPreview("");
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
                className="gt-editor__text"
                value={current.content}
                onChange={event => updateStageContent(event.target.value)}
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
              <button className="gt-btn gt-btn--sm" type="button" onClick={onImagePrompt} disabled={busy !== ""}>
                {busy === "prompt" ? "生成中…" : "配图提示词"}
              </button>
              <button
                className="gt-btn gt-btn--sm"
                type="button"
                onClick={() => setShowImages(value => !value)}
                disabled={busy !== ""}
              >
                {showImages ? "收起配图" : "插入图片"}
              </button>
              <button className="gt-btn gt-btn--sm" type="button" onClick={onProseCheck} disabled={busy !== "" || !current.content.trim()}>
                {busy === "prose" ? "体检中…" : "查 AI 味"}
              </button>
              <span className="gt-spacer" />
              {stage === "article" ? (
                <>
                  <label className="gt-small gt-muted" htmlFor="gt-wx-template">
                    排版
                  </label>
                  <select
                    id="gt-wx-template"
                    className="gt-select"
                    value={templateId}
                    onChange={event => void onTemplateChange(event.target.value)}
                  >
                    <optgroup label="内置配色">
                      {templates
                        .filter(item => item.source === "builtin")
                        .map(item => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </optgroup>
                    {templates.some(item => item.source !== "builtin") ? (
                      <optgroup label="我的模板">
                        {templates
                          .filter(item => item.source !== "builtin")
                          .map(item => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </optgroup>
                    ) : null}
                  </select>
                  <button className="gt-btn gt-btn--sm" type="button" onClick={onCopyFormatted} disabled={busy !== ""}>
                    {busy === "copy" ? "复制中…" : "复制排版正文"}
                  </button>
                  <button className="gt-btn gt-btn--sm gt-btn--blue" type="button" onClick={onPreview} disabled={busy !== ""}>
                    {busy === "preview" ? "预览中…" : "公众号预览"}
                  </button>
                </>
              ) : null}
            </div>
          </section>

          {showImages ? (
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

          {preview ? (
            <section className="gt-panel gt-panel--flat">
              <div className="gt-panel__head">
                <h3 className="gt-panel__title">公众号预览</h3>
                <button className="gt-btn gt-btn--sm" type="button" onClick={() => setPreview("")}>
                  收起
                </button>
              </div>
              <div className="gt-preview">
                <div className="gt-preview__frame" dangerouslySetInnerHTML={{ __html: preview }} />
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
