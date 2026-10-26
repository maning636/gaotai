"use client";

import { useCallback, useEffect, useState } from "react";

type PublicConfig = {
  model: string;
  apiBaseUrl: string;
  systemPrompt: string;
  temperature: number;
  reasoningEffort?: string;
  apiKeyMasked: string;
  updatedAt?: string;
};

const EMPTY = {
  model: "deepseek-chat",
  apiBaseUrl: "https://api.deepseek.com",
  apiKey: "",
  systemPrompt: "",
  temperature: "0.7",
  reasoningEffort: "minimal",
};

/** 思考强度选项。空值 = 跟随端点默认（很多端点不认这个参数，不传最稳）。 */
const EFFORT_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "", label: "跟随模型默认", hint: "不发送这个参数，兼容性最好" },
  { value: "minimal", label: "minimal · 几乎不思考", hint: "写长文用这个，额度基本留给正文" },
  { value: "none", label: "none · 完全不思考", hint: "模型直接落笔，部分端点不支持" },
  { value: "low", label: "low · 少思考", hint: "保留一点推理，额度消耗小" },
  { value: "medium", label: "medium", hint: "常规强度" },
  { value: "high", label: "high", hint: "深度推理，额度消耗大" },
  { value: "max", label: "max · 最多思考", hint: "最费额度，也最容易把正文挤没" },
];

/** 模型配置面板。 */
export default function AgentConfigPanel() {
  const [form, setForm] = useState(EMPTY);
  const [maskedKey, setMaskedKey] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | undefined>();
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "warn"; text: string }>({ tone: "warn", text: "" });

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/agent-config", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "读取配置失败。");
      const config = body.config as PublicConfig | undefined;
      if (!config) return;
      setForm({
        model: config.model || EMPTY.model,
        apiBaseUrl: config.apiBaseUrl || EMPTY.apiBaseUrl,
        apiKey: "",
        systemPrompt: config.systemPrompt ?? "",
        temperature: String(config.temperature ?? EMPTY.temperature),
        reasoningEffort: config.reasoningEffort ?? "",
      });
      setMaskedKey(config.apiKeyMasked ?? "");
      setUpdatedAt(config.updatedAt);
    } catch (issue) {
      setNotice({ tone: "error", text: issue instanceof Error ? issue.message : "读取配置失败。" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function update(field: keyof typeof EMPTY, value: string) {
    setForm(current => ({ ...current, [field]: value }));
  }

  async function onSave() {
    if (busy) return;
    setBusy("save");
    try {
      const response = await fetch("/api/agent-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          config: {
            model: form.model.trim(),
            apiBaseUrl: form.apiBaseUrl.trim(),
            ...(form.apiKey ? { apiKey: form.apiKey } : {}),
            systemPrompt: form.systemPrompt,
            temperature: Number(form.temperature),
            reasoningEffort: form.reasoningEffort,
          },
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "保存失败。");
      setMaskedKey(body.config?.apiKeyMasked ?? "");
      setUpdatedAt(body.config?.updatedAt);
      setForm(current => ({ ...current, apiKey: "" }));
      setShowKey(false);
      setNotice({ tone: "ok", text: "配置已保存。" });
    } catch (issue) {
      setNotice({ tone: "error", text: issue instanceof Error ? issue.message : "保存失败。" });
    } finally {
      setBusy("");
    }
  }

  async function onTest() {
    if (busy) return;
    setBusy("test");
    try {
      const response = await fetch("/api/agent-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          config: {
            model: form.model.trim(),
            apiBaseUrl: form.apiBaseUrl.trim(),
            ...(form.apiKey ? { apiKey: form.apiKey } : {}),
            systemPrompt: form.systemPrompt,
            temperature: Number(form.temperature),
            reasoningEffort: form.reasoningEffort,
          },
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "测试失败。");
      setNotice({ tone: body.ok ? "ok" : "error", text: body.message ?? (body.ok ? "连接成功。" : "连接失败") });
    } catch (issue) {
      setNotice({ tone: "error", text: issue instanceof Error ? issue.message : "测试失败。" });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="gt-stack gt-stack--lg">
      {notice.text ? (
        <div className={`gt-alert gt-alert--${notice.tone === "ok" ? "ok" : notice.tone === "error" ? "error" : "warn"}`}>
          {notice.text}
        </div>
      ) : null}

      <section className="gt-panel gt-panel--flat gt-stack">
        <div className="gt-panel__head">
          <div>
            <h2 className="gt-panel__title">模型接入</h2>
            <p className="gt-small gt-muted" style={{ margin: "4px 0 0" }}>
              稿台直连 OpenAI 兼容的 <code className="gt-code gt-code--inline">/chat/completions</code>，不经过任何中间框架。
            </p>
          </div>
          {updatedAt ? <span className="gt-small gt-mono gt-muted">{updatedAt}</span> : null}
        </div>

        <div className="gt-grid gt-grid--2">
          <label className="gt-field">
            <span className="gt-label">模型名</span>
            <input
              className="gt-input"
              value={form.model}
              onChange={event => update("model", event.target.value)}
              placeholder="deepseek-chat"
              disabled={busy !== ""}
            />
          </label>
          <label className="gt-field">
            <span className="gt-label">API Base URL</span>
            <input
              className="gt-input"
              value={form.apiBaseUrl}
              onChange={event => update("apiBaseUrl", event.target.value)}
              placeholder="https://api.deepseek.com"
              disabled={busy !== ""}
            />
          </label>
          <label className="gt-field" style={{ gridColumn: "1 / -1" }}>
            <span className="gt-label">API Key</span>
            <div className="gt-row" style={{ gap: "8px", flexWrap: "nowrap" }}>
              <input
                className="gt-input"
                type={showKey ? "text" : "password"}
                value={form.apiKey}
                onChange={event => {
                  setShowKey(true);
                  update("apiKey", event.target.value);
                }}
                placeholder={maskedKey || "sk-…"}
                autoComplete="off"
                disabled={busy !== ""}
              />
              <button className="gt-btn gt-btn--sm" type="button" onClick={() => setShowKey(current => !current)} disabled={busy !== ""}>
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
            <span className="gt-hint">
              留空表示沿用已保存的密钥。密钥加密后存在本机，界面上只显示掩码。
            </span>
          </label>
          <label className="gt-field">
            <span className="gt-label">Temperature</span>
            <input
              className="gt-input"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={form.temperature}
              onChange={event => update("temperature", event.target.value)}
              disabled={busy !== ""}
            />
          </label>
          <label className="gt-field">
            <span className="gt-label">思考强度</span>
            <select
              className="gt-input"
              value={form.reasoningEffort}
              onChange={event => update("reasoningEffort", event.target.value)}
              disabled={busy !== ""}
            >
              {EFFORT_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="gt-hint">
              {EFFORT_OPTIONS.find(option => option.value === form.reasoningEffort)?.hint ??
                "不发送这个参数，兼容性最好"}
              。带思考的模型会把输出额度分给思考，思考占满了正文就是空的——写长文建议调 none。
            </span>
          </label>
          <label className="gt-field">
            <span className="gt-label">附加系统提示（可选）</span>
            <textarea
              className="gt-textarea"
              value={form.systemPrompt}
              onChange={event => update("systemPrompt", event.target.value)}
              placeholder="追加到每一道工序系统提示末尾的额外要求"
              disabled={busy !== ""}
            />
          </label>
        </div>

        <div className="gt-row gt-row--end">
          <button className="gt-btn" type="button" onClick={onTest} disabled={busy !== ""}>
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          <button className="gt-btn gt-btn--primary" type="button" onClick={onSave} disabled={busy !== ""}>
            {busy === "save" ? "保存中…" : "保存配置"}
          </button>
        </div>
        <p className="gt-hint" style={{ margin: 0 }}>
          测试连接会用当前表单里的值发一条 ping，不写盘；只有「保存配置」才会持久化。
        </p>
      </section>
    </div>
  );
}
