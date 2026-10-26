import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import LayoutPanel from "./panel";
import { readSession } from "../../lib/auth";

/** 排版模板页。 */
export default async function LayoutPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell title="排版" description="样式包进来，取舍一遍，固化成你自己的模板。">
      <LayoutPanel />
    </AppShell>
  );
}
