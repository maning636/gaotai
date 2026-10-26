import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import { DeleteProjectButton } from "./delete-button";
import { readSession } from "../../lib/auth";
import { listProjects } from "../../lib/repo";
import { listTopics } from "../../lib/topics";
import { STAGE_LABELS } from "../../lib/db";

/** 全部稿件。 */
export default async function ProjectsPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  const [projects, topics] = await Promise.all([listProjects({ limit: 300 }), listTopics()]);
  const topicNames = new Map(topics.map(topic => [topic.id, topic.name]));

  return (
    <AppShell
      title="稿件"
      description={`一共 ${projects.length} 篇，按最近修改排序。`}
      actions={
        <Link className="gt-btn gt-btn--primary" href="/">
          新建稿件
        </Link>
      }
    >
      {projects.length === 0 ? (
        <div className="gt-empty">
          <span className="gt-empty__mark">空</span>
          还没有稿件。回到工作台开一篇。
        </div>
      ) : (
        <div className="gt-panel gt-panel--flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="gt-table">
            <thead>
              <tr className="gt-table__head">
                <th className="gt-table__cell">标题</th>
                <th className="gt-table__cell">专题</th>
                <th className="gt-table__cell">当前工序</th>
                <th className="gt-table__cell">最近修改</th>
                <th className="gt-table__cell" />
              </tr>
            </thead>
            <tbody>
              {projects.map(project => (
                <tr className="gt-table__row" key={project.id}>
                  <td className="gt-table__cell">
                    <Link href={`/projects/${project.id}`} style={{ fontWeight: 700 }}>
                      {project.title}
                    </Link>
                  </td>
                  <td className="gt-table__cell">{topicNames.get(project.topic_id) ?? project.topic_id}</td>
                  <td className="gt-table__cell">
                    <span className="gt-tag gt-tag--blue">{STAGE_LABELS[project.stage]}</span>
                  </td>
                  <td className="gt-table__cell gt-mono gt-muted">
                    {new Date(project.updated_at).toLocaleString("zh-CN")}
                  </td>
                  <td className="gt-table__cell" style={{ textAlign: "right" }}>
                    <DeleteProjectButton id={project.id} title={project.title} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
