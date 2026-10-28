import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import { readSession } from "../../lib/auth";
import { LicensePanel } from "./license-panel";

/** 授权页：注册码激活、状态展示、功能清单。 */
export default async function LicensePage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell
      title="授权"
      description="这套软件免费使用，激活只是为了让我知道是谁在用，顺便管住我的技能包不被直接搬走。"
    >
      <LicensePanel />
    </AppShell>
  );
}
