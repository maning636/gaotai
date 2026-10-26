import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import StyleMemoryPanel from "./panel";
import { readSession } from "../../lib/auth";

/** 风格画像页。 */
export default async function StyleMemoryPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell title="风格" description="你的写作习惯，是怎么从修改记录里长出来的。">
      <StyleMemoryPanel />
    </AppShell>
  );
}
