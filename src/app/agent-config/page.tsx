import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import AgentConfigPanel from "./panel";
import { readSession } from "../../lib/auth";
import { agentConfigFile } from "../../lib/paths";

/** 模型配置页。 */
export default async function AgentConfigPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell title="模型" description={`配置存在本机 ${agentConfigFile()}，密钥是加密的。`}>
      <AgentConfigPanel />
    </AppShell>
  );
}
