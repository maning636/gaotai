import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import { TemplatesShell } from "./templates-shell";
import { readSession } from "../../lib/auth";

/**
 * 模板页：挑模板和管模板在同一个页面里，用 Tab 区分。
 *
 * - 默认「模板库」：平铺浏览 + 手机预览，点「使用这套」写回当前稿件。
 * - 「模板管理」：原来的导入 / 取舍 / 改色 / 存模板面板。
 *
 * `searchParams.project` 是稿件 id；`searchParams.tab=manage` 直接落在管理面板
 * （旧 /layout 链接重定向到这里）。
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; tab?: string }>;
}) {
  const session = await readSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const projectId = sp.project?.trim() ?? "";
  const initialTab = sp.tab === "manage" ? "manage" : "gallery";

  return (
    <AppShell
      title="模板"
      description="挑一套看效果；导入样式包、改色值、存自己的模板，都在「模板管理」里。"
    >
      <TemplatesShell projectId={projectId} initialTab={initialTab} />
    </AppShell>
  );
}
