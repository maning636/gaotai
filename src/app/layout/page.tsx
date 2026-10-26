import { redirect } from "next/navigation";

/**
 * 兼容旧入口：排版管理已经并到 /templates 的「模板管理」Tab。
 * 保留这条路由做重定向，避免旧书签 / 文档链接 404。
 */
export default function LayoutPage() {
  redirect("/templates?tab=manage");
}
