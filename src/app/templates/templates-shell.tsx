"use client";

import { useState } from "react";
import { Gallery } from "./gallery";
import LayoutPanel from "../layout/panel";
import styles from "./templates.module.css";

/**
 * 模板页的外壳：一个页面，两个 Tab。
 *
 * 为什么合并而不是两个页面：
 *   「挑一套」和「改一套」用的是同一份模板库，用户的心智是「模板」这一件事；
 *   分成两个导航项会让人以为要各看一遍，实际只是两种操作模式。
 *
 * 默认进「模板库」（浏览 + 手机预览）；要导入样式包、取舍部件、改色值，
 * 切到「模板管理」——它就是原来的 /layout 面板，逻辑一行没改。
 * URL 的 ?tab=manage 让旧链接与书签仍然落在管理面板。
 */
export function TemplatesShell({
  projectId,
  initialTab,
}: {
  projectId: string;
  initialTab: "gallery" | "manage";
}) {
  const [tab, setTab] = useState<"gallery" | "manage">(initialTab);

  return (
    <>
      <div className={styles.tabs} role="tablist" aria-label="模板">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "gallery"}
          className={`${styles.tab}${tab === "gallery" ? " " + styles.tabActive : ""}`}
          onClick={() => setTab("gallery")}
        >
          模板库
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "manage"}
          className={`${styles.tab}${tab === "manage" ? " " + styles.tabActive : ""}`}
          onClick={() => setTab("manage")}
        >
          模板管理
        </button>
      </div>
      {tab === "gallery" ? <Gallery projectId={projectId} /> : <LayoutPanel />}
    </>
  );
}
