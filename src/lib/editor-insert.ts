/**
 * 把一段 Markdown（插图语法）插到正文的指定位置。
 *
 * 插图必须落在用户光标处，而不是永远拼到末尾。
 * 位置来自编辑框最后一次已知的光标；从没点过编辑框时传 null，退回末尾。
 *
 * 前后自动补空行：`![x](url)` 贴着正文会和老段落粘成一行，
 * 公众号里看起来像正文的一部分。
 */
export function insertMarkdownAt(
  base: string,
  position: number | null,
  snippet: string,
): { content: string; caret: number } {
  const at = position === null ? base.length : Math.min(Math.max(0, position), base.length);
  const before = base.slice(0, at);
  const after = base.slice(at);
  const lead = before
    ? before.endsWith("\n\n")
      ? ""
      : before.endsWith("\n")
        ? "\n"
        : "\n\n"
    : "";
  const tail = after ? (after.startsWith("\n") ? "" : "\n\n") : "\n";
  return {
    content: `${before}${lead}${snippet}${tail}${after}`,
    caret: at + lead.length + snippet.length,
  };
}
