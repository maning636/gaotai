import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import { readSession } from "../../lib/auth";
import { listEdits, listProjects } from "../../lib/repo";
import { listTopics } from "../../lib/topics";
import { STAGES, STAGE_LABELS } from "../../lib/stages";

/** 概览：这台机器上的创作轨迹。 */
export default async function OverviewPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  const [projects, topics, edits] = await Promise.all([
    listProjects({ limit: 1000 }),
    listTopics(),
    listEdits({ limit: 5000 }),
  ]);

  const byStage = new Map<string, number>(STAGES.map(stage => [stage, 0]));
  const byTopic = new Map<string, number>();
  for (const project of projects) {
    byStage.set(project.stage, (byStage.get(project.stage) ?? 0) + 1);
    byTopic.set(project.topic_id, (byTopic.get(project.topic_id) ?? 0) + 1);
  }
  const topicNames = new Map(topics.map(topic => [topic.id, topic.name]));
  const confirmed = projects.filter(project => project.stage === "article").length;
  const thisWeek = projects.filter(project => project.updated_at > Date.now() - 7 * 24 * 60 * 60 * 1000).length;

  return (
    <AppShell title="概览" description="这台机器上的创作轨迹。">
      <div className="gt-stack gt-stack--lg">
        <div className="gt-grid gt-grid--4">
          <div className="gt-card">
            <div className="gt-eyebrow">稿件</div>
            <div className="gt-display" style={{ fontSize: "38px", margin: 0 }}>
              {projects.length}
            </div>
          </div>
          <div className="gt-card">
            <div className="gt-eyebrow">本周动过</div>
            <div className="gt-display" style={{ fontSize: "38px", margin: 0 }}>
              {thisWeek}
            </div>
          </div>
          <div className="gt-card">
            <div className="gt-eyebrow">走到正文</div>
            <div className="gt-display" style={{ fontSize: "38px", margin: 0 }}>
              {confirmed}
            </div>
          </div>
          <div className="gt-card">
            <div className="gt-eyebrow">人工修改</div>
            <div className="gt-display" style={{ fontSize: "38px", margin: 0 }}>
              {edits.length}
            </div>
          </div>
        </div>

        <div className="gt-grid gt-grid--2">
          <section className="gt-panel gt-panel--flat">
            <div className="gt-panel__head">
              <h2 className="gt-panel__title">稿件卡在哪一步</h2>
            </div>
            <div className="gt-stack gt-stack--sm">
              {STAGES.map(stage => {
                const count = byStage.get(stage) ?? 0;
                const percent = projects.length ? Math.round((count / projects.length) * 100) : 0;
                return (
                  <div key={stage}>
                    <div className="gt-row gt-row--between">
                      <span className="gt-small">{STAGE_LABELS[stage]}</span>
                      <span className="gt-small gt-mono">
                        {count} 篇 · {percent}%
                      </span>
                    </div>
                    <div
                      style={{
                        height: "14px",
                        border: "2px solid var(--gt-line)",
                        background: "var(--gt-sunken)",
                      }}
                    >
                      <div style={{ width: `${percent}%`, height: "100%", background: "var(--gt-blue)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="gt-panel gt-panel--flat">
            <div className="gt-panel__head">
              <h2 className="gt-panel__title">按专题分布</h2>
            </div>
            {byTopic.size === 0 ? (
              <p className="gt-small gt-muted" style={{ margin: 0 }}>
                还没有稿件。
              </p>
            ) : (
              <div className="gt-stack gt-stack--sm">
                {[...byTopic.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([topicId, count]) => (
                    <div className="gt-row gt-row--between" key={topicId}>
                      <Link href="/projects">{topicNames.get(topicId) ?? topicId}</Link>
                      <span className="gt-tag">{count} 篇</span>
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>

        <section className="gt-panel gt-panel--flat">
          <div className="gt-panel__head">
            <h2 className="gt-panel__title">最近的人工修改</h2>
            <span className="gt-small gt-muted">风格画像就是从这些记录里提炼的</span>
          </div>
          {edits.length === 0 ? (
            <p className="gt-small gt-muted" style={{ margin: 0 }}>
              还没有修改记录。在稿件里改一改 AI 的产出，攒够 6 次就能生成风格画像。
            </p>
          ) : (
            <div className="gt-stack gt-stack--sm">
              {[...edits]
                .reverse()
                .slice(0, 8)
                .map(edit => (
                  <div className="gt-diff" key={edit.id} style={{ gridTemplateColumns: "1fr 1fr" }}>
                    <div className="gt-diff__col">
                      <div className="gt-diff__label">改前</div>
                      <div className="gt-diff__text gt-diff__text--before">
                        {edit.before_text.slice(0, 220) || "（空）"}
                      </div>
                    </div>
                    <div className="gt-diff__col">
                      <div className="gt-diff__label">改后</div>
                      <div className="gt-diff__text gt-diff__text--after">
                        {edit.after_text.slice(0, 220) || "（空）"}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
