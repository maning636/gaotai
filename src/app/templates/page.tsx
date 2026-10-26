import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import { Gallery } from "./gallery";
import { readSession } from "../../lib/auth";

/**
 * 模板库：把「选排版」从编辑器里的下拉框搬出来，
 * 让排版能像素材一样一眼看过去。
 *
 * 这一页只做两件事：确认登录、把客户端画廊套进壳里。
 * 数据、选中、应用全在客户端组件里，服务端不掺业务。
 * `searchParams.project` 是稿件 id；带它进来的画廊右侧「使用这套」才能生效。
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await readSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const projectId = sp.project?.trim() ?? "";

  return (
    <AppShell
      title="模板库"
      description="左边挑一套，右边看效果。点卡片只是切换预览；要落到稿件上，点右边手机下的「使用这套」。"
      actions={
        <a className="gt-btn gt-btn--ghost" href="/layout">
          管理模板
        </a>
      }
    >
      <Gallery projectId={projectId} />
    </AppShell>
  );
}
