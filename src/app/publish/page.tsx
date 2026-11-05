import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import PublishPanel from "./panel";
import { readSession } from "../../lib/auth";

/** 发布页：把图、视频、文案送出去。 */
export default async function PublishPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell title="发布" description="把图、视频、文案送出去。">
      <PublishPanel />
    </AppShell>
  );
}
