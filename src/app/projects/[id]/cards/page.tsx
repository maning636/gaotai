import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { AppShell } from "../../../app-shell";
import { CardsPanel } from "./panel";
import { readSession } from "../../../../lib/auth";
import { getProject, getStageResult } from "../../../../lib/repo";
import { getTopic } from "../../../../lib/topics";

/**
 * 知识卡片模式页。
 *
 * 把一篇稿子做成竖版多页卡片（3:4 / 3:5 / 9:16 三种比例 × 17 套主题），
 * 可实时预览、单张复制到剪贴板、批量导出 PNG 到本机文件夹。
 * 正文取「文章正文」阶段的产出，与排版预览页同一口径。
 */
export default async function ProjectCardsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const project = getProject(id);
  if (!project) notFound();

  const [article, topic] = await Promise.all([
    getStageResult(id, "article"),
    getTopic(project.topic_id),
  ]);

  return (
    <AppShell
      title="知识卡片"
      description={`《${project.title}》—— 挑一套主题与比例，把正文排成竖版卡片，预览后单张复制或批量导出 PNG。`}
      actions={
        <Link className="gt-btn gt-btn--ghost" href={`/projects/${encodeURIComponent(id)}/preview`}>
          去排版预览
        </Link>
      }
    >
      <CardsPanel
        projectId={id}
        projectTitle={project.title}
        topicName={topic?.name ?? project.topic_id}
        articleContent={article?.content ?? ""}
      />
    </AppShell>
  );
}
