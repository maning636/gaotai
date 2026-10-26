import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import FilesPanel from "./panel";
import { readSession } from "../../lib/auth";
import { imagesDir } from "../../lib/paths";

/** 素材库页。 */
export default async function FilesPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <AppShell title="素材" description={`本地生成的配图都收在 ${imagesDir()}。`}>
      <FilesPanel />
    </AppShell>
  );
}
