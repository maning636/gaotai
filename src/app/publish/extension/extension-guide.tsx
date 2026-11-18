"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./extension-guide.module.css";

/**
 * 浏览器插件安装指导（客户端组件）。
 *
 * 为什么浏览器插件必须"手装"：Chrome/Edge 没有任何静默安装入口，
 * 只能由用户在扩展管理页里「加载已解压的扩展程序」并选中一个真实文件夹。
 * 所以这一页要做的不是"替用户装"，而是把三件事说清楚并给出可点的按钮：
 *   1. 文件夹在哪（能一键打开、能复制路径）；
 *   2. 浏览器里怎么点（带具体地址和按钮名）；
 *   3. 装完怎么确认——点「检测连接」，由稿台真的问一次桥接服务。
 *
 * 第 3 步是关键：用户最常见的失败不是"不会装"，而是"以为装上了"——
 * 装到了另一个浏览器、装完没刷新、或者选错了目录。只有真连通了才算数。
 */

type ExtensionPlatform = { id: string; name: string };

type ExtensionInfo = {
  available: boolean;
  dir: string;
  version: string;
  name: string;
  platforms: ExtensionPlatform[];
  connected: boolean;
  extensions: number;
  port: number;
};

/** preload 暴露的桌面能力；纯浏览器打开时不存在。 */
type DesktopBridge = {
  extensionDir?: () => Promise<string>;
  openExtensionDir?: () => Promise<{ ok: boolean; dir?: string; error?: string }>;
};

const DETECT_ROUNDS = 8;
const DETECT_INTERVAL_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ExtensionGuide() {
  const [info, setInfo] = useState<ExtensionInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [round, setRound] = useState(0);
  const [verdict, setVerdict] = useState<"" | "ok" | "bad">("");
  const [copied, setCopied] = useState<"path" | "url" | "">("");

  const desktop = useMemo<DesktopBridge | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { gaotai?: DesktopBridge }).gaotai;
  }, []);

  const fetchInfo = useCallback(async (): Promise<ExtensionInfo | null> => {
    try {
      const response = await fetch("/api/extension/info", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as Partial<ExtensionInfo>;
      if (!response.ok) return null;
      return {
        available: body.available === true,
        dir: typeof body.dir === "string" ? body.dir : "",
        version: typeof body.version === "string" ? body.version : "",
        name: typeof body.name === "string" ? body.name : "",
        platforms: Array.isArray(body.platforms) ? body.platforms : [],
        connected: body.connected === true,
        extensions: typeof body.extensions === "number" ? body.extensions : 0,
        port: typeof body.port === "number" ? body.port : 0,
      };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void fetchInfo().then((next) => {
      if (next) setInfo(next);
      else setLoadError("读取扩展信息失败，请刷新页面重试。");
    });
  }, [fetchInfo]);

  // 已连上就停掉后续无意义的检测。
  useEffect(() => {
    if (info?.connected && verdict !== "ok") setVerdict("ok");
  }, [info?.connected, verdict]);

  const openFolder = async () => {
    if (!desktop?.openExtensionDir) {
      setLoadError("当前不在桌面客户端里，请按下方路径手动打开文件夹。");
      return;
    }
    const result = await desktop.openExtensionDir().catch(() => null);
    if (!result?.ok) {
      setLoadError(result?.error ? `打开文件夹失败：${result.error}` : "打开文件夹失败，请按路径手动打开。");
    }
  };

  const copy = async (text: string, kind: "path" | "url") => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setLoadError("复制失败，请手动选中文本复制。");
    }
  };

  /** 检测连接：连续问几次桥接状态，中途连上就算成功。 */
  const verify = async () => {
    setVerifying(true);
    setVerdict("");
    for (let i = 1; i <= DETECT_ROUNDS; i += 1) {
      setRound(i);
      const next = await fetchInfo();
      if (next) {
        setInfo(next);
        if (next.connected) {
          setVerdict("ok");
          setVerifying(false);
          return;
        }
      }
      if (i < DETECT_ROUNDS) await sleep(DETECT_INTERVAL_MS);
    }
    setVerdict("bad");
    setVerifying(false);
  };

  const tone = !info?.available ? "bad" : info.connected ? "ok" : "warn";
  const bannerClass =
    tone === "ok" ? `${styles.banner} ${styles.bannerOk}` : tone === "warn" ? `${styles.banner} ${styles.bannerWarn}` : `${styles.banner} ${styles.bannerBad}`;
  const dotColor = tone === "ok" ? "var(--gt-green)" : tone === "warn" ? "var(--gt-yellow)" : "var(--gt-red)";

  const bannerTitle = !info
    ? "正在读取扩展信息…"
    : !info.available
      ? "本机没有找到扩展文件"
      : info.connected
        ? `已连接${info.extensions > 1 ? `（${info.extensions} 个标签页）` : ""}`
        : "扩展还没连上";

  const bannerMeta = !info
    ? ""
    : !info.available
      ? "安装包可能不完整，请联系作者重新获取安装包。"
      : info.connected
        ? `桥接端口 ${info.port} · 扩展 v${info.version}`
        : info.dir;

  return (
    <div className={styles.wrap}>
      <div className={bannerClass}>
        <span className={styles.bannerDot} style={{ background: dotColor }} />
        <span className={styles.bannerText}>
          <span className={styles.bannerTitle}>{bannerTitle}</span>
          {bannerMeta ? <span className={styles.bannerMeta}>{bannerMeta}</span> : null}
        </span>
      </div>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>为什么需要装这个插件</h2>
        <p className={styles.cardHint}>
          公众号有官方接口，稿台可以直接推草稿。但知乎、掘金、小红书、抖音这些平台没有开放写稿接口，
          只能由浏览器里已登录的你去点。插件的作用就是把稿台的正文送进这些平台的编辑器，
          省掉复制粘贴——它在你本机运行，账号密码不会离开你的浏览器。
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>三步装好</h2>

        <div className={styles.steps}>
          <div className={styles.step}>
            <span className={styles.stepNo}>1</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>打开扩展文件夹</span>
              <p className={styles.stepDesc}>
                插件文件已经随稿台装在电脑上了。点下面的按钮打开它，先别关窗口——第 3 步要在这里选目录。
              </p>
              <div className={styles.pathBox}>
                <code className={styles.path}>{info?.dir || "正在获取路径…"}</code>
                <button type="button" className={styles.btn} onClick={() => copy(info?.dir ?? "", "path")} disabled={!info?.dir}>
                  {copied === "path" ? "已复制" : "复制路径"}
                </button>
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={openFolder} disabled={!info?.available}>
                  打开文件夹
                </button>
              </div>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNo}>2</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>在浏览器里打开扩展管理页，并开启「开发者模式」</span>
              <p className={styles.stepDesc}>
                Chrome 地址栏输入 <code className={styles.code}>chrome://extensions</code>；
                Edge 输入 <code className={styles.code}>edge://extensions</code>。
                打开右上角（Edge 在左下角）的「开发者模式」开关。
              </p>
              <div className={styles.actions}>
                <button type="button" className={styles.btn} onClick={() => copy("chrome://extensions", "url")}>
                  {copied === "url" ? "已复制" : "复制 chrome://extensions"}
                </button>
              </div>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNo}>3</span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>点「加载已解压的扩展程序」，选中第 1 步那个文件夹</span>
              <p className={styles.stepDesc}>
                选完列表里会出现「{info?.name || "稿台多平台分发"}」。
                注意选的是<b>包含 manifest.json 的那一层</b>，不是它的上级目录。
              </p>
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={`${styles.btn} ${styles.btnGreen}`} onClick={verify} disabled={verifying || !info?.available}>
            {verifying ? `正在检测…（第 ${round}/${DETECT_ROUNDS} 次）` : "我装好了，检测连接"}
          </button>
          <button type="button" className={styles.btn} onClick={() => void fetchInfo().then((next) => next && setInfo(next))}>
            刷新状态
          </button>
        </div>

        {verdict === "ok" ? (
          <div className={`${styles.result} ${styles.resultOk}`}>
            检测通过：扩展已经连上稿台，可以去「多平台分发」发稿了。
          </div>
        ) : null}

        {verdict === "bad" ? (
          <div className={`${styles.result} ${styles.resultBad}`}>
            还没连上。按顺序排查这几种情况：
            <ul className={styles.reasons}>
              <li>扩展列表里是不是出现了「{info?.name || "稿台多平台分发"}」，有没有被禁用；</li>
              <li>刚装完需要刷新一下这个页面，扩展才会重新连；</li>
              <li>插件是不是装到了另一个浏览器（比如稿台用的是 Chrome，你却装到了 Edge）；</li>
              <li>第 3 步选目录时，是否选到了上一级（要选中含 manifest.json 的那层）。</li>
            </ul>
            改完再点一次「检测连接」，不用重启稿台。
          </div>
        ) : null}

        {loadError ? <div className={`${styles.result} ${styles.resultBad}`}>{loadError}</div> : null}
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          这个插件支持 {info?.platforms.length ?? 0} 个平台
        </h2>
        <div className={styles.chips}>
          {(info?.platforms ?? []).map((platform) => (
            <span key={platform.id} className={styles.chip}>
              {platform.name}
            </span>
          ))}
        </div>
        <p className={styles.footnote}>
          公众号不走插件，走官方接口，在「发布 → 图文上传」里直接推草稿。
          插件只负责那些没有开放接口的平台。
        </p>
      </section>
    </div>
  );
}
