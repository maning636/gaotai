import type { Metadata, Viewport } from "next";
import "./globals.css";
import { UpdateGate } from "./update/update-gate";

export const metadata: Metadata = {
  title: "稿台",
  description: "本地运行的公众号写作工作台：把素材一步步变成能发出去的稿子。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        {/* 版本更新覆盖层：放在 children 之外、body 之内，任何页面（含登录页）都会被盖住。 */}
        <UpdateGate />
      </body>
    </html>
  );
}
