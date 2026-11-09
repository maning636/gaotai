"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Project = { id: string; title: string; stage: string };
type Published = { articleId: string; title: string; author: string; url: string; updateTime: number };
type Stat = { articleId: string; title: string; readCount: number; likeCount: number; shareCount: number; commentCount: number };
type LocalImage = { path: string; size: number; mtime: string; url: string };
type Cover = { configured: boolean; image: string; previewUrl: string };
type FailedImage = { ref: string; reason: string };
/** 公众号账号清单条目（secret 不进前端）。 */
type WechatAccountView = {
  id: string;
  name: string;
  appIdMasked: string;
};
/** 正在编辑的账号草稿：编辑框里的状态，保存时才真正落 .env。 */
type AccountDraft = {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
};
/** 公众号账号最多保存几个，与后端一致。 */
const MAX_ACCOUNTS = 5;
/** 公众号通道的检查结果。ok 为 false 时 reason/hint 说清是什么问题、下一步做什么。 */
type ChannelCheck = {
  ok: boolean;
  reason: string;
  hint: string;
  egressIp?: string;
  errcode?: number;
};
/** 排版模板条目：内置配色与用户自己固化的模板同列。 */
type LayoutTemplateItem = {
  id: string;
  name: string;
  source: "builtin" | "imported" | "custom";
};

/**
 * 公众号面板。
 *
 * 三件事分开摆：配凭据 → 备封面 → 推草稿 → 看已发布的数据。
 * 稿台只负责把稿子变成能粘贴的 HTML 并放进草稿箱，发布这一步仍然归人。
 */
export default function WechatPanel() {
  const [configured, setConfigured] = useState(false);
  const [appIdMasked, setAppIdMasked] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [published, setPublished] = useState<Published[]>([]);
  const [stats, setStats] = useState<Stat[]>([]);
  const [busy, setBusy] = useState<"" | "config" | "sync" | "stats" | "draft" | "cover" | "test">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  /** 通道检查结果。没测过就是 null，「推到草稿箱」在它不是 ok 时不给点。 */
  const [channel, setChannel] = useState<ChannelCheck | null>(null);
  /** 推草稿箱时用的排版模板。按稿件记，每篇可以不一样。 */
  const [templateId, setTemplateId] = useState("builtin:default");
  /** 可选的排版模板：内置配色 + 用户自己固化的模板。 */
  const [templates, setTemplates] = useState<LayoutTemplateItem[]>([]);

  // 封面：草稿必须带封面，界面得给用户一个能设置的地方。
  const [cover, setCover] = useState<Cover>({ configured: false, image: "", previewUrl: "" });
  const [images, setImages] = useState<LocalImage[]>([]);
  const [libraryPick, setLibraryPick] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // 多账号管理
  const [accounts, setAccounts] = useState<WechatAccountView[]>([]);
  const [accountDrafts, setAccountDrafts] = useState<AccountDraft[]>([]);
  const [busyAccounts, setBusyAccounts] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/wechat/config", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "读取配置失败。");
      setConfigured(Boolean(body.configured));
      setAppIdMasked(body.appIdMasked ?? "");
      const saved = (Array.isArray(body.accounts) ? body.accounts : []) as WechatAccountView[];
      setAccounts(saved);
      // 编辑草稿初始化：已存账号带 id（AppID/Secret 留空，保存时沿用旧值）；
      // 若编辑区已有未保存的行（prev 非空），只同步名称，不覆盖用户正在填的内容。
      setAccountDrafts(prev => {
        if (prev.length === 0) {
          return saved.map(account => ({ id: account.id, name: account.name, appId: "", appSecret: "" }));
        }
        return prev.map(draft => {
          const match = saved.find(account => account.id === draft.id);
          return match ? { ...draft, name: match.name } : draft;
        });
      });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取配置失败。");
    }
  }, []);

  const loadCover = useCallback(async () => {
    try {
      const response = await fetch("/api/wechat/cover", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "读取封面失败。");
      setCover({
        configured: Boolean(body.configured),
        image: body.image ?? "",
        previewUrl: body.previewUrl ?? "",
      });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "读取封面失败。");
    }
  }, []);

  const loadImages = useCallback(async () => {
    try {
      const response = await fetch("/api/files", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return;
      setImages(Array.isArray(body) ? body : []);
    } catch {
      // 素材列表读不到不影响主流程
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadCover();
    void loadImages();
    (async () => {
      try {
        const response = await fetch("/api/projects", { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        const list: Project[] = body.projects ?? [];
        setProjects(list);
        const ready = list.find(project => project.stage === "article");
        if (ready) setProjectId(ready.id);
      } catch {
        // 稿件列表读不到不影响配置区
      }
    })();
  }, [loadConfig, loadCover, loadImages]);

  // 打开面板就测一次。
  // 用户最想知道的不是「配没配」，是「到底能不能用」——
  // 而能不能用这个答案，只有真的问一次微信才知道。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await fetch("/api/wechat/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = await response.json().catch(() => ({}));
        if (alive && body && typeof body.ok === "boolean") setChannel(body);
      } catch {
        // 测不了就先不管，用户可以手动点「测试连接」。
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 排版模板清单：内置配色 + 用户固化的模板。
  useEffect(() => {
    let alive = true;
    fetch("/api/layout-templates", { cache: "no-store" })
      .then(response => (response.ok ? response.json().catch(() => ({})) : Promise.reject(new Error("读取模板失败"))))
      .then((body: { templates?: LayoutTemplateItem[] }) => {
        if (alive) setTemplates(Array.isArray(body.templates) ? body.templates : []);
      })
      .catch(() => {
        if (alive) setTemplates([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 换一篇稿件，就把那篇记住的排版拿过来。
  // 排版是按稿件记的：上一篇用暖纸，这一篇不一定也想用暖纸。
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    fetch(`/api/wechat/theme?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then(response => (response.ok ? response.json().catch(() => ({})) : Promise.reject(new Error("读取排版失败"))))
      .then((body: { templateId?: string }) => {
        if (alive) setTemplateId(body.templateId || "builtin:default");
      })
      .catch(() => {
        if (alive) setTemplateId("builtin:default");
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  /**
   * 测一次通道。
   *
   * 输入框里填了值就测填的值（用户正在试新的 AppID），
   * 没填就测 .env 里存的那份。**只测不存**——保存是「保存配置」按钮的活。
   */
  async function runChannelCheck(override?: { appId: string; appSecret: string }): Promise<ChannelCheck> {
    const payload = override ?? (appId || appSecret ? { appId, appSecret } : {});
    const response = await fetch("/api/wechat/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "测试失败。");
    const result: ChannelCheck = body;
    setChannel(result);
    return result;
  }

  /** 单独点「测试连接」：不保存，只看通不通。 */
  async function onTestChannel() {
    if (busy) return;
    setBusy("test");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const result = await runChannelCheck();
      if (result.ok) {
        setNotice("通道测试通过，可以推到草稿箱了。");
      } else {
        setWarning(`${result.reason}。${result.hint}`);
      }
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "测试失败。");
    } finally {
      setBusy("");
    }
  }

  async function onSaveConfig(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy("config");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, appSecret }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "保存失败。");
      setConfigured(true);
      setAppIdMasked(body.appIdMasked ?? "");
      setAppId("");
      setAppSecret("");
      // 存完立刻测一次：用户最想知道的不是「配没配」，是「到底能不能用」。
      const checked = await runChannelCheck();
      if (checked.ok) {
        setNotice("公众号配置已保存到本地 .env，通道测试通过。");
      } else {
        setNotice("公众号配置已保存到本地 .env。");
        setWarning(`${checked.reason}。${checked.hint}`);
      }
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "保存失败。");
    } finally {
      setBusy("");
    }
  }

  /** 从本机选一张图，直接上传并设为封面。 */
  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    setBusy("cover");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/wechat/cover", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "设置封面失败。");
      setCover({ configured: true, image: body.image ?? "", previewUrl: body.previewUrl ?? "" });
      setNotice("封面已更新。");
      await loadImages();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "设置封面失败。");
    } finally {
      setBusy("");
    }
  }

  /** 用素材库里已有的图当封面。 */
  async function onUseLibraryImage() {
    if (!libraryPick || busy) return;
    setBusy("cover");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: libraryPick }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "设置封面失败。");
      setCover({ configured: true, image: body.image ?? "", previewUrl: body.previewUrl ?? "" });
      setNotice("封面已更新。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "设置封面失败。");
    } finally {
      setBusy("");
    }
  }

  async function onClearCover() {
    if (busy) return;
    setBusy("cover");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/cover", { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "清空封面失败。");
      setCover({ configured: false, image: "", previewUrl: "" });
      setNotice("封面已清空。");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "清空封面失败。");
    } finally {
      setBusy("");
    }
  }

  async function onSync() {
    if (busy) return;
    setBusy("sync");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/sync", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "同步失败。");
      setPublished(body.items ?? []);
      setNotice(`同步到 ${body.items?.length ?? 0} 篇已发布文章。`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "同步失败。");
    } finally {
      setBusy("");
    }
  }

  async function onStats() {
    if (busy) return;
    setBusy("stats");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/statistics", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "拉取统计失败。");
      setStats(body.stats ?? []);
      setNotice(`拿到 ${body.stats?.length ?? 0} 天的数据。`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "拉取统计失败。");
    } finally {
      setBusy("");
    }
  }

  async function onDraft() {
    if (busy) return;
    if (!projectId) {
      setError("先选一篇稿件。");
      return;
    }
    if (!cover.configured) {
      setError("还没有封面图。公众号草稿必须带封面，请先在上面设一张。");
      return;
    }
    // 按钮已经禁用了，这里再拦一道：万一状态刚变（比如刚测失败），
    // 「先测后发」这条规矩也不该只靠一个 disabled 属性守着。
    if (!channel?.ok) {
      setError(
        `公众号通道还没测通：${channel?.reason ?? "还没测过"}。${
          channel?.hint ?? "先在上面点「测试连接」，测通了才能推。"
        }`,
      );
      return;
    }
    setBusy("draft");
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, templateId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "推送失败。");
      const uploaded = Number(body.uploadedImages ?? 0);
      const cached = Number(body.cachedImages ?? 0);
      const failed: FailedImage[] = Array.isArray(body.failedImages) ? body.failedImages : [];
      setNotice(
        [
          `已放进草稿箱：${body.title}`,
          uploaded > 0 ? `正文图片已上传 ${uploaded} 张到微信。` : "",
          cached > 0 ? `${cached} 张复用缓存。` : "",
        ]
          .filter(Boolean)
          .join(""),
      );
      if (failed.length) {
        setWarning(
          `有 ${failed.length} 张图没能上传：${failed.map(item => `${item.ref}（${item.reason}）`).join("；")}。这些图在公众号里会显示不出来。`,
        );
      }
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "推送失败。");
    } finally {
      setBusy("");
    }
  }

  /* ---------------- 多账号管理 ---------------- */

  /** 更新某个账号草稿的字段。 */
  function updateAccountDraft(index: number, patch: Partial<AccountDraft>) {
    setAccountDrafts(prev => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  /** 新增一行空账号草稿。 */
  function addAccountDraft() {
    setAccountDrafts(prev => (prev.length >= MAX_ACCOUNTS ? prev : [...prev, { id: "", name: "", appId: "", appSecret: "" }]));
  }

  /** 删掉一行账号草稿（只动编辑态，点了保存才落 .env）。 */
  function removeAccountDraft(index: number) {
    setAccountDrafts(prev => prev.filter((_, i) => i !== index));
  }

  /** 把编辑好的账号清单保存到后端（.env）。 */
  async function onSaveAccounts() {
    if (busyAccounts) return;
    // 已有账号（带 id）允许 AppID/Secret 留空——后端会沿用旧值；
    // 新账号必须填全，否则无从保存。
    const incomplete = accountDrafts.find(draft => !draft.id && (!draft.appId.trim() || !draft.appSecret.trim()));
    if (incomplete) {
      setError("有账号还没填全 AppID / AppSecret，先补全或删掉。");
      return;
    }
    setBusyAccounts(true);
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts: accountDrafts.map(draft => ({
            id: draft.id,
            name: draft.name,
            appId: draft.appId,
            appSecret: draft.appSecret,
          })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "保存账号失败。");
      setAccounts(Array.isArray(body.accounts) ? body.accounts : []);
      setNotice(`已保存 ${body.accounts?.length ?? 0} 个公众号账号。`);
      await loadConfig();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "保存账号失败。");
    } finally {
      setBusyAccounts(false);
    }
  }

  /** 测某个账号草稿的通道（只测不存）。 */
  async function onTestAccount(index: number) {
    if (busyAccounts) return;
    const draft = accountDrafts[index];
    if (!draft.appId || !draft.appSecret) {
      setError("先填全这个账号的 AppID / AppSecret 再测。");
      return;
    }
    setBusyAccounts(true);
    setError("");
    setNotice("");
    setWarning("");
    try {
      const response = await fetch("/api/wechat/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: draft.appId, appSecret: draft.appSecret }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "测试失败。");
      if (body.ok) setNotice(`账号「${draft.name || draft.appId}」测试通过。`);
      else setWarning(`${draft.name || draft.appId}：${body.reason}。${body.hint}`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "测试失败。");
    } finally {
      setBusyAccounts(false);
    }
  }

  return (
    <div className="gt-stack gt-stack--lg">
      {error ? <div className="gt-alert gt-alert--error">{error}</div> : null}
      {warning ? <div className="gt-alert gt-alert--warn">{warning}</div> : null}
      {notice ? <div className="gt-alert gt-alert--ok">{notice}</div> : null}

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">公众号接入</h2>
          <span
            className={`gt-tag ${
              !configured ? "gt-tag--yellow" : channel?.ok ? "gt-tag--green" : channel ? "gt-tag--pink" : "gt-tag--yellow"
            }`}
          >
            {!configured
              ? "未配置"
              : channel?.ok
                ? "通道已通"
                : channel
                  ? "通道不通"
                  : "未测试"}
          </span>
        </div>
        <form onSubmit={onSaveConfig} className="gt-stack">
          <div className="gt-grid gt-grid--2">
            <label className="gt-field">
              <span className="gt-label">AppID</span>
              <input
                className="gt-input"
                value={appId}
                onChange={event => setAppId(event.target.value)}
                placeholder="wx…"
                autoComplete="off"
              />
            </label>
            <label className="gt-field">
              <span className="gt-label">AppSecret</span>
              <div className="gt-row" style={{ gap: "8px", flexWrap: "nowrap" }}>
                <input
                  className="gt-input"
                  type={showSecret ? "text" : "password"}
                  value={appSecret}
                  onChange={event => setAppSecret(event.target.value)}
                  placeholder="只保存在本机 .env"
                  autoComplete="off"
                />
                <button
                  className="gt-btn gt-btn--sm"
                  type="button"
                  onClick={() => setShowSecret(current => !current)}
                >
                  {showSecret ? "隐藏" : "显示"}
                </button>
              </div>
            </label>
          </div>
          <div className="gt-row gt-row--end" style={{ gap: "8px" }}>
            <button
              className="gt-btn"
              type="button"
              onClick={() => void onTestChannel()}
              disabled={busy !== "" || (!appId && !appSecret && !configured)}
            >
              {busy === "test" ? "测试中…" : "测试连接"}
            </button>
            <button className="gt-btn gt-btn--primary" type="submit" disabled={busy !== "" || !appId || !appSecret}>
              {busy === "config" ? "保存中…" : "保存并测试"}
            </button>
          </div>
          <p className="gt-hint" style={{ margin: 0 }}>
            凭据只写进本机数据目录下的 .env，不进数据库、不进日志、不随安装包分发。
            {appIdMasked ? ` 当前：${appIdMasked}。` : ""}
            {channel && !channel.ok && channel.egressIp
              ? ` 微信看到的本机出口 IP 是 ${channel.egressIp}，把它加进公众号后台的 IP 白名单即可。`
              : ""}
          </p>
        </form>
      </section>

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">多账号管理</h2>
          <span className="gt-tag gt-tag--green">
            {accounts.length} / {MAX_ACCOUNTS}
          </span>
        </div>
        <div className="gt-stack">
          <p className="gt-hint" style={{ margin: 0 }}>
            一个稿台可以接多个公众号。每个账号有自己的 AppID / AppSecret，
            推草稿前在预览页选择要推给哪个公众号。
          </p>
          {accountDrafts.map((draft, index) => (
            <div className="gt-grid gt-grid--2" key={draft.id || index} style={{ alignItems: "end" }}>
              <label className="gt-field">
                <span className="gt-label">账号名称</span>
                <input
                  className="gt-input"
                  value={draft.name}
                  onChange={event => updateAccountDraft(index, { name: event.target.value })}
                  placeholder="例如：公司主号"
                  autoComplete="off"
                />
              </label>
              <div className="gt-field">
                <span className="gt-label">AppID</span>
                <input
                  className="gt-input"
                  value={draft.appId}
                  onChange={event => updateAccountDraft(index, { appId: event.target.value })}
                  placeholder={draft.id ? "已保存，留空则不变" : "wx…"}
                  autoComplete="off"
                />
              </div>
              <div className="gt-field">
                <span className="gt-label">AppSecret</span>
                <input
                  className="gt-input"
                  type="password"
                  value={draft.appSecret}
                  onChange={event => updateAccountDraft(index, { appSecret: event.target.value })}
                  placeholder={draft.id ? "已保存，留空则不变" : "只保存在本机 .env"}
                  autoComplete="off"
                />
              </div>
              <div className="gt-row" style={{ gap: "8px" }}>
                <button
                  className="gt-btn gt-btn--sm gt-btn--ghost"
                  type="button"
                  disabled={busyAccounts}
                  onClick={() => void onTestAccount(index)}
                >
                  测试
                </button>
                <button
                  className="gt-btn gt-btn--sm gt-btn--ghost"
                  type="button"
                  disabled={busyAccounts || accountDrafts.length <= 1}
                  onClick={() => removeAccountDraft(index)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
          <div className="gt-row" style={{ gap: "8px" }}>
            <button
              className="gt-btn gt-btn--sm"
              type="button"
              disabled={busyAccounts || accountDrafts.length >= MAX_ACCOUNTS}
              onClick={addAccountDraft}
            >
              + 添加账号
            </button>
            <button
              className="gt-btn gt-btn--primary"
              type="button"
              disabled={busyAccounts || accountDrafts.length === 0}
              onClick={() => void onSaveAccounts()}
            >
              {busyAccounts ? "保存中…" : "保存账号清单"}
            </button>
          </div>
          {accountDrafts.length >= MAX_ACCOUNTS ? (
            <p className="gt-hint" style={{ margin: 0 }}>
              最多保存 {MAX_ACCOUNTS} 个公众号账号。
            </p>
          ) : null}
        </div>
      </section>

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">封面图</h2>
          <span className={`gt-tag ${cover.configured ? "gt-tag--green" : "gt-tag--yellow"}`}>
            {cover.configured ? "已就绪" : "缺封面"}
          </span>
        </div>
        <div className="gt-grid gt-grid--2">
          <div className="gt-stack gt-stack--sm">
            {cover.configured && cover.previewUrl ? (
              <img
                src={cover.previewUrl}
                alt="当前封面"
                className="gt-cover-preview"
                style={{ maxWidth: "220px", border: "3px solid var(--gt-ink)", display: "block" }}
              />
            ) : (
              <p className="gt-hint" style={{ margin: 0 }}>
                公众号草稿必须带一张封面图（永久素材），否则推送会被微信拒掉。
              </p>
            )}
            <div className="gt-row" style={{ gap: "8px", flexWrap: "wrap" }}>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="gt-hidden-input"
                style={{ display: "none" }}
                onChange={event => void onPickFile(event)}
              />
              <button
                className="gt-btn"
                type="button"
                disabled={busy !== "" || !configured}
                onClick={() => fileInput.current?.click()}
              >
                {busy === "cover" ? "处理中…" : "从本机选一张"}
              </button>
              {cover.configured ? (
                <button className="gt-btn gt-btn--sm" type="button" disabled={busy !== ""} onClick={() => void onClearCover()}>
                  清除封面
                </button>
              ) : null}
            </div>
            <p className="gt-hint" style={{ margin: 0 }}>
              {configured
                ? "选中的图会存进本机素材库，并上传到微信永久素材库换一张封面凭证。"
                : "先把上面的 AppID / AppSecret 填好，封面要上传到微信才能拿到凭证。"}
            </p>
          </div>
          <div className="gt-stack gt-stack--sm">
            <label className="gt-field">
              <span className="gt-label">或用素材库里已有的图</span>
              <select
                className="gt-select"
                value={libraryPick}
                onChange={event => setLibraryPick(event.target.value)}
                disabled={busy !== "" || images.length === 0}
              >
                <option value="">— 选择 —</option>
                {images.map(image => (
                  <option key={image.path} value={image.path}>
                    {image.path}
                  </option>
                ))}
              </select>
            </label>
            <div className="gt-row">
              <button
                className="gt-btn gt-btn--sm"
                type="button"
                disabled={busy !== "" || !libraryPick || !configured}
                onClick={() => void onUseLibraryImage()}
              >
                设为封面
              </button>
            </div>
            <p className="gt-hint" style={{ margin: 0 }}>
              素材库里的图是稿台生成的配图和正文插图，{images.length} 张。
            </p>
          </div>
        </div>
      </section>

      <section className="gt-panel gt-panel--flat">
        <div className="gt-panel__head">
          <h2 className="gt-panel__title">推草稿箱</h2>
        </div>
        <div className="gt-row">
          <label className="gt-field" style={{ minWidth: "280px" }}>
            <span className="gt-label">选一篇走完正文的稿件</span>
            <select className="gt-select" value={projectId} onChange={event => setProjectId(event.target.value)}>
              <option value="">— 选择 —</option>
              {projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label className="gt-field" style={{ minWidth: "160px" }}>
            <span className="gt-label">排版模板</span>
            <select
              className="gt-select"
              value={templateId}
              onChange={event => {
                const next = event.target.value;
                setTemplateId(next);
                if (!projectId) return;
                // 立刻记回这篇稿子的偏好，推的时候不用再选一次。
                void fetch("/api/wechat/theme", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ projectId, templateId: next }),
                }).catch(() => {
                  // 记不住也不影响推送，推的时候请求里会带着这份模板。
                });
              }}
            >
              <optgroup label="内置配色">
                {templates
                  .filter(item => item.source === "builtin")
                  .map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </optgroup>
              {templates.some(item => item.source !== "builtin") ? (
                <optgroup label="我的模板">
                  {templates
                    .filter(item => item.source !== "builtin")
                    .map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          <button
            className="gt-btn gt-btn--primary"
            type="button"
            onClick={() => void onDraft()}
            disabled={busy !== "" || !projectId || !cover.configured || !channel?.ok}
          >
            {busy === "draft" ? "推送中…" : "推到草稿箱"}
          </button>
        </div>
        <p className="gt-hint" style={{ marginBottom: 0 }}>
          推上去之后去公众号后台预览、编辑、发布。稿台不代替人点发布。
          {!cover.configured ? " 还需要先设一张封面图。" : ""}
          {!channel?.ok
            ? " 通道没测通之前不给推——先在上面点「测试连接」。"
            : ""}
          {channel && !channel.ok ? ` 当前卡在：${channel.reason}。` : ""}
        </p>
      </section>

      <div className="gt-grid gt-grid--2">
        <section className="gt-panel gt-panel--flat">
          <div className="gt-panel__head">
            <h2 className="gt-panel__title">已发布文章</h2>
            <button className="gt-btn gt-btn--sm" type="button" onClick={() => void onSync()} disabled={busy !== ""}>
              {busy === "sync" ? "同步中…" : "同步"}
            </button>
          </div>
          {published.length === 0 ? (
            <p className="gt-small gt-muted" style={{ margin: 0 }}>
              还没同步过。
            </p>
          ) : (
            <div className="gt-stack gt-stack--sm">
              {published.map(article => (
                <div className="gt-row gt-row--between" key={article.articleId}>
                  <span className="gt-small" style={{ fontWeight: 700 }}>
                    {article.title || "（无标题）"}
                  </span>
                  <span className="gt-small gt-mono gt-muted">
                    {article.updateTime ? new Date(article.updateTime * 1000).toLocaleDateString("zh-CN") : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="gt-panel gt-panel--flat">
          <div className="gt-panel__head">
            <h2 className="gt-panel__title">阅读数据（近 7 天）</h2>
            <button className="gt-btn gt-btn--sm" type="button" onClick={() => void onStats()} disabled={busy !== ""}>
              {busy === "stats" ? "拉取中…" : "拉取"}
            </button>
          </div>
          {stats.length === 0 ? (
            <p className="gt-small gt-muted" style={{ margin: 0 }}>
              还没拉过。
            </p>
          ) : (
            <table className="gt-table">
              <thead>
                <tr className="gt-table__head">
                  <th className="gt-table__cell">文章</th>
                  <th className="gt-table__cell">阅读</th>
                  <th className="gt-table__cell">在看</th>
                  <th className="gt-table__cell">分享</th>
                </tr>
              </thead>
              <tbody>
                {stats.map(stat => (
                  <tr className="gt-table__row" key={stat.articleId || stat.title}>
                    <td className="gt-table__cell gt-small">{stat.title || "（无标题）"}</td>
                    <td className="gt-table__cell gt-mono">{stat.readCount}</td>
                    <td className="gt-table__cell gt-mono">{stat.likeCount}</td>
                    <td className="gt-table__cell gt-mono">{stat.shareCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
