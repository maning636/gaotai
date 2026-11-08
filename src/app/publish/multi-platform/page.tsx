import { redirect } from "next/navigation";
import { AppShell } from "../../app-shell";
import { MultiPlatformPanel } from "./multi-platform-panel";
import { readSession } from "../../../lib/auth";

/** 多平台分发页：把稿件推到浏览器扩展，再填进目标平台编辑器。 */
export default async function MultiPlatformPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell title="多平台分发" description="通过浏览器扩展，把稿子一键推到 30+ 个内容平台：自媒体、技术社区、财经、建站与海外。">
      <MultiPlatformPanel />
    </AppShell>
  );
}
