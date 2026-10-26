import { assertEqual, assertTrue, suite } from "./harness";
import {
  appendMessage,
  countEdits,
  createProject,
  deleteProject,
  getProject,
  getStageResult,
  listEdits,
  listMessages,
  listProjects,
  listStageResults,
  recordEdit,
  saveStageResult,
  updateProject,
} from "../lib/repo";

suite("稿件与阶段数据", ({ test }) => {
  test("新建稿件落在 brief 阶段且带唯一 id", () => {
    const project = createProject({ title: "测试稿", topicId: "general" });
    assertTrue(project.id.startsWith("prj_"));
    assertEqual(project.stage, "brief");
    assertEqual(project.title, "测试稿");
    assertEqual(getProject(project.id)?.id, project.id);
  });

  test("空标题回退成未命名稿件", () => {
    const project = createProject({ title: "   ", topicId: "general" });
    assertEqual(project.title, "未命名稿件");
  });

  test("列表按最近修改排序", () => {
    const first = createProject({ title: "先", topicId: "general" });
    const second = createProject({ title: "后", topicId: "general" });
    updateProject(second.id, { title: "后（改名）" });
    const ids = listProjects().map(p => p.id);
    assertTrue(ids.indexOf(second.id) < ids.indexOf(first.id), "改过的稿件应排在前面");
  });

  test("阶段产出可覆盖写入并保留确认态", () => {
    const project = createProject({ title: "阶段", topicId: "general" });
    saveStageResult({ projectId: project.id, stage: "brief", content: "第一版", status: "draft" });
    const second = saveStageResult({ projectId: project.id, stage: "brief", content: "第二版", status: "confirmed" });
    assertEqual(second.content, "第二版");
    assertEqual(second.status, "confirmed");
    assertEqual(listStageResults(project.id).length, 1, "同一阶段只保留一份");
    assertEqual(getStageResult(project.id, "brief")?.content, "第二版");
  });

  test("不同阶段各自独立", () => {
    const project = createProject({ title: "多阶段", topicId: "general" });
    saveStageResult({ projectId: project.id, stage: "brief", content: "材料", status: "confirmed" });
    saveStageResult({ projectId: project.id, stage: "angle", content: "角度", status: "draft" });
    assertEqual(listStageResults(project.id).length, 2);
    assertEqual(getStageResult(project.id, "angle")?.content, "角度");
  });

  test("对话按阶段隔离", () => {
    const project = createProject({ title: "对话", topicId: "general" });
    appendMessage({ projectId: project.id, stage: "brief", role: "user", content: "问一句" });
    appendMessage({ projectId: project.id, stage: "brief", role: "assistant", content: "答一句" });
    appendMessage({ projectId: project.id, stage: "article", role: "user", content: "另一个阶段" });
    assertEqual(listMessages(project.id, "brief").length, 2);
    assertEqual(listMessages(project.id, "article").length, 1);
    assertEqual(listMessages(project.id).length, 3);
  });

  test("人工修改被完整记录，且能按专题统计", () => {
    const project = createProject({ title: "改稿", topicId: "tech-deep-read" });
    recordEdit({ projectId: project.id, stage: "article", beforeText: "AI 写的", afterText: "人改的" });
    recordEdit({ projectId: project.id, stage: "article", beforeText: "第二版", afterText: "第二版改" });
    const edits = listEdits({ projectId: project.id });
    assertEqual(edits.length, 2);
    assertEqual(edits[0].before_text, "AI 写的");
    assertEqual(edits[0].after_text, "人改的");
    assertEqual(countEdits("tech-deep-read"), 2);
    assertEqual(countEdits("general"), 0);
  });

  test("删除稿件会带走它的阶段数据", () => {
    const project = createProject({ title: "待删", topicId: "general" });
    saveStageResult({ projectId: project.id, stage: "brief", content: "内容", status: "draft" });
    assertEqual(deleteProject(project.id), true);
    assertEqual(getProject(project.id), null);
    assertEqual(listStageResults(project.id).length, 0);
    assertEqual(deleteProject(project.id), false);
  });

  test("改标题不会清空其它字段", () => {
    const project = createProject({ title: "原名", topicId: "general" });
    updateProject(project.id, { title: "新名" });
    const updated = getProject(project.id)!;
    assertEqual(updated.title, "新名");
    assertEqual(updated.topic_id, "general");
    assertEqual(updated.stage, "brief");
  });
});
