import { redirect } from "next/navigation";
import { AppShell } from "../../app-shell";
import { ExtensionGuide } from "./extension-guide";
import { readSession } from "../../../lib/auth";

/** 插件安装指导页：把浏览器扩展装上并验证连通，才能用多平台分发。 */
export default async function ExtensionGuidePage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell
      title="插件安装指导"
      description="多平台分发需要一个浏览器插件。照这一页做完三步，再点「检测连接」验证，通过了就能发稿。"
    >
      <ExtensionGuide />
    </AppShell>
  );
}
