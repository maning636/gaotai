import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../app-shell";
import { ProjectEditor } from "./editor";
import { readSession } from "../../../lib/auth";
import { getProject, getWxPreference, listMessages, listStageResults } from "../../../lib/repo";
import { getTopic } from "../../../lib/topics";

/** 稿件页：四道工序的主工作区。 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const project = getProject(id);
  if (!project) notFound();

  const [stages, messages, topic, wx] = await Promise.all([
    listStageResults(id),
    listMessages(id),
    getTopic(project.topic_id),
    getWxPreference(id),
  ]);

  return (
    <AppShell
      title={project.title}
      description={`专题：${topic?.name ?? project.topic_id}`}
      actions={
        <a className="gt-btn gt-btn--ghost" href="/projects">
          全部稿件
        </a>
      }
    >
      <ProjectEditor
        project={{
          id: project.id,
          title: project.title,
          topic_id: project.topic_id,
          stage: project.stage,
        }}
        topic={topic ? { id: topic.id, name: topic.name, rules: topic.rules, skills: topic.skills } : null}
        initialStages={stages}
        initialMessages={messages}
        wxTheme={wx?.theme}
        wxTemplateId={wx?.template_id || undefined}
      />
    </AppShell>
  );
}
