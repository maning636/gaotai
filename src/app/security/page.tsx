import { redirect } from "next/navigation";
import { AppShell } from "../app-shell";
import { LogoutButton } from "./logout-button";
import { readSession } from "../../lib/auth";
import { listLoginFailures } from "../../lib/login-audit";
import { agentConfigFile, dataStorageDir, envFile, imagesDir } from "../../lib/paths";

/** 安全页：登录痕迹、数据落地位置、退出。 */
export default async function SecurityPage() {
  const session = await readSession();
  if (!session) redirect("/login");

  const failures = await listLoginFailures(50);

  return (
    <AppShell
      title="安全"
      description="程序只在本机跑，密钥和数据都不出这台机器。"
      actions={<LogoutButton />}
    >
      <div className="gt-stack gt-stack--lg">
        <section className="gt-panel gt-panel--flat">
          <div className="gt-panel__head">
            <h2 className="gt-panel__title">数据都放在哪儿</h2>
          </div>
          <div className="gt-stack gt-stack--sm">
            <div>
              <div className="gt-small gt-muted">密钥与登录配置</div>
              <code className="gt-code">{envFile()}</code>
            </div>
            <div>
              <div className="gt-small gt-muted">数据库</div>
              <code className="gt-code">{dataStorageDir()}</code>
            </div>
            <div>
              <div className="gt-small gt-muted">模型配置（密钥加密后存这里）</div>
              <code className="gt-code">{agentConfigFile()}</code>
            </div>
            <div>
              <div className="gt-small gt-muted">本地配图</div>
              <code className="gt-code">{imagesDir()}</code>
            </div>
          </div>
          <p className="gt-small gt-muted" style={{ marginBottom: 0 }}>
            这些文件全在用户数据目录里，不进安装包，也不会随程序更新被覆盖。删掉就是彻底删掉了。
          </p>
        </section>

        <section className="gt-panel gt-panel--flat">
          <div className="gt-panel__head">
            <h2 className="gt-panel__title">登录失败记录</h2>
            <span className="gt-small gt-muted">最近 {failures.length} 条</span>
          </div>
          {failures.length === 0 ? (
            <p className="gt-small gt-muted" style={{ margin: 0 }}>
              没有失败记录。
            </p>
          ) : (
            <table className="gt-table">
              <thead>
                <tr className="gt-table__head">
                  <th className="gt-table__cell">时间</th>
                  <th className="gt-table__cell">来源</th>
                  <th className="gt-table__cell">客户端</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((failure, index) => (
                  <tr className="gt-table__row" key={`${failure.at}-${index}`}>
                    <td className="gt-table__cell gt-mono">{new Date(failure.at).toLocaleString("zh-CN")}</td>
                    <td className="gt-table__cell gt-mono">{failure.ip}</td>
                    <td className="gt-table__cell gt-small gt-muted">{failure.ua || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="gt-small gt-muted" style={{ marginBottom: 0 }}>
            只记录时间、来源地址和浏览器标识，不记录任何口令内容。连续失败过多时登录接口会直接拒绝。
          </p>
        </section>
      </div>
    </AppShell>
  );
}
