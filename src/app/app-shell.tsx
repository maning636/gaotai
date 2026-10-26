"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * 应用外壳：左侧导航 + 右侧主区。
 *
 * 这里只负责"壳"——导航、高亮、标题栏。鉴权与数据都在各页面里做，
 * 壳不掺和业务逻辑，换页面也不用改它。
 */

export type AppShellProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
};

const NAV_SECTIONS: { label: string; items: { href: string; label: string }[] }[] = [
  {
    label: "写作",
    items: [
      { href: "/", label: "工作台" },
      { href: "/projects", label: "稿件" },
      { href: "/overview", label: "概览" },
    ],
  },
  {
    label: "资产",
    items: [
      { href: "/style-memory", label: "风格" },
      { href: "/layout", label: "排版" },
      { href: "/files", label: "素材" },
    ],
  },
  {
    label: "接入",
    items: [
      { href: "/wechat", label: "公众号" },
      { href: "/agent-config", label: "模型" },
    ],
  },
];

export function AppShell({ title, description, actions, children }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div className="gt-app">
      <aside className="gt-sidebar">
        <Link href="/" className="gt-sidebar__brand" style={{ textDecoration: "none" }}>
          <span className="gt-sidebar__mark" aria-hidden="true">
            台
          </span>
          <div>
            <span className="gt-sidebar__name">稿台</span>
            <span className="gt-sidebar__tagline">把素材一步步写成能发出去的稿子</span>
          </div>
        </Link>
        <nav className="gt-nav" aria-label="主导航">
          {NAV_SECTIONS.map(section => (
            <div className="gt-nav__group" key={section.label}>
              <span className="gt-nav__label">{section.label}</span>
              {section.items.map(item => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`gt-nav__item${active ? " gt-nav__item--active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    prefetch={false}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="gt-sidebar__foot">
          <Link href="/security" className="gt-nav__item" prefetch={false}>
            安全
          </Link>
          <span className="gt-mono">v0.1.0 · 本地运行</span>
        </div>
      </aside>

      <div className="gt-main">
        <header className="gt-main__header">
          <div>
            <h1 className="gt-main__title">{title}</h1>
            {description ? <p className="gt-lead">{description}</p> : null}
          </div>
          {actions ? <div className="gt-main__actions">{actions}</div> : null}
        </header>
        <main className="gt-main__body">{children}</main>
      </div>
    </div>
  );
}
