import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { AppShell } from "../../../app-shell";
import { PreviewPanel } from "./panel";
import { readSession } from "../../../../lib/auth";
import { getProject, getStageResult, getWxPreference } from "../../../../lib/repo";
import { getTopic } from "../../../../lib/topics";
import { normalizeThemeId } from "../../../../lib/wx-theme";
import { templateIdForTheme } from "../../../../lib/layout-store";

/**
 * 排版预览页：签字确认后的排版操作都在这里。
 *
 * 编辑器底部只留写稿和配图相关的按钮；换模板、看手机预览、复制排版正文、
 * 推到草稿箱，全收到这一个页面——用户不用在编辑器里跟一长排按钮较劲。
 */
export default async function ProjectPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const project = getProject(id);
  if (!project) notFound();

  const [article, wx, topic] = await Promise.all([
    getStageResult(id, "article"),
    getWxPreference(id),
    getTopic(project.topic_id),
  ]);

  // 排版偏好：没存过模板就回退到内置配色那套，跟模板页/预览接口同一口径。
  const theme = normalizeThemeId(wx?.theme);
  const templateId = wx?.template_id || templateIdForTheme(theme);

  return (
    <AppShell
      title="排版预览"
      description={`《${project.title}》—— 挑一套排版，看真实正文排出来的效果，再复制或推草稿箱。`}
      actions={
        <Link className="gt-btn gt-btn--ghost" href={`/projects/${encodeURIComponent(id)}`}>
          返回编辑器
        </Link>
      }
    >
      <PreviewPanel
        projectId={id}
        projectTitle={project.title}
        topicName={topic?.name ?? project.topic_id}
        articleContent={article?.content ?? ""}
        articleStatus={article?.status ?? "empty"}
        initialTemplateId={templateId}
      />
    </AppShell>
  );
}
