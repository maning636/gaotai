import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "./app-shell";
import NewProjectPanel from "./new-project";
import ImportProjectPanel from "./import-project";
import { readSession } from "../lib/auth";
import { listProjects } from "../lib/repo";
import { listTopics } from "../lib/topics";
import { STAGE_LABELS } from "../lib/db";

/**
 * 工作台。
 *
 * 首页只做两件事：开新稿、看最近的稿子。
 * 真正的活儿在稿件页里。
 */
export default async function HomePage() {
  const session = await readSession();
  if (!session) redirect("/login");

  const [topics, projects] = await Promise.all([listTopics(), Promise.resolve(listProjects({ limit: 8 }))]);

  return (
    <AppShell
      title="工作台"
      description="把素材交给 AI，四道工序走完就是一篇文章。"
      actions={
        <Link className="gt-btn gt-btn--ghost" href="/projects">
          全部稿件
        </Link>
      }
    >
      <div className="gt-stack gt-stack--lg">
        <NewProjectPanel topics={topics} />
        <ImportProjectPanel topics={topics} />

        <section className="gt-stack">
          <div className="gt-row gt-row--between">
            <h2 className="gt-heading" style={{ margin: 0 }}>
              最近的稿件
            </h2>
            <span className="gt-small gt-muted">共 {projects.length} 篇</span>
          </div>

          {projects.length === 0 ? (
            <div className="gt-empty">
              <span className="gt-empty__mark">空</span>
              还没有稿件。上面建一篇，AI 会先帮你读材料。
            </div>
          ) : (
            <div className="gt-grid gt-grid--2">
              {projects.map(project => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="gt-card"
                  style={{ textDecoration: "none", display: "block" }}
                >
                  <div className="gt-row gt-row--between" style={{ marginBottom: "6px" }}>
                    <strong className="gt-sub" style={{ margin: 0 }}>
                      {project.title}
                    </strong>
                    <span className="gt-tag gt-tag--blue">{STAGE_LABELS[project.stage]}</span>
                  </div>
                  <div className="gt-small gt-muted gt-mono">
                    {new Date(project.updated_at).toLocaleString("zh-CN")}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
