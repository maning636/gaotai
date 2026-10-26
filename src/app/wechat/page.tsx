import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import WechatPanel from "./panel";
import { readSession } from "../../lib/auth";

/** 公众号页。 */
export default async function WechatPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell title="公众号" description="把稿子送进草稿箱，剩下的交给人。">
      <WechatPanel />
    </AppShell>
  );
}
