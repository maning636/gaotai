/**
 * 把 HTML 洗成 Markdown。
 *
 * **为什么导入已有文章需要这一步**：
 * 稿台的渲染器只认 Markdown——遇到原始 HTML 节点会**转义成文字**
 * （这是防脚本注入的必要代价）。所以用户从公众号后台、Word、别的编辑器里
 * 复制来的文章，直接贴进来会变成一堆 `&lt;p&gt;` 字面量。
 *
 * 导入的时候先洗一遍，后面所有环节（排版、封面、推草稿箱）就都只面对 Markdown。
 *
 * 洗的目标是**保住语义，丢掉样式**：
 * 标题还是标题、加粗还是加粗、图还是图、链接还是链接；
 * 颜色、字号、居中这些排版信息丢掉（它们由稿台的排版模板负责）。
 */

/** 先删掉整块的脚本与样式——它们的内容不该进正文。 */
function dropDangerousBlocks(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** 图片：<img src="x" alt="y" /> → ![y](x) */
function convertImages(html: string): string {
  return html.replace(/<img\b([^>]*)>/gi, (_whole, attrs: string) => {
    const src = attrs.match(/\bsrc\s*=\s*"([^"]*)"/i)?.[1] ?? attrs.match(/\bsrc\s*=\s*'([^']*)'/i)?.[1] ?? "";
    const alt = attrs.match(/\balt\s*=\s*"([^"]*)"/i)?.[1] ?? attrs.match(/\balt\s*=\s*'([^']*)'/i)?.[1] ?? "";
    if (!src) return "";
    return `![${alt}](${src})`;
  });
}

/** 链接：<a href="x">text</a> → [text](x) */
function convertLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_whole, attrs: string, inner: string) => {
    const href = attrs.match(/\bhref\s*=\s*"([^"]*)"/i)?.[1] ?? attrs.match(/\bhref\s*=\s*'([^']*)'/i)?.[1] ?? "";
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (!href || href.startsWith("javascript:")) return text;
    if (!text) return "";
    return `[${text}](${href})`;
  });
}

/** 标题：<h1>..</h1> → # .. */
function convertHeadings(html: string): string {
  return html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_whole, level: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "";
  });
}

/** 行内强调：<strong>/<b> → **，<em>/<i> → * */
function convertInline(html: string): string {
  return html
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_w, _t, inner: string) => `**${inner.trim()}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_w, _t, inner: string) => `*${inner.trim()}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_w, inner: string) => `\`${inner.replace(/<[^>]+>/g, "").trim()}\``)
    .replace(/<del\b[^>]*>([\s\S]*?)<\/del\s*>/gi, (_w, inner: string) => `~~${inner.replace(/<[^>]+>/g, "").trim()}~~`)
    .replace(/<br\s*\/?\s*>/gi, "\n");
}

/** 引用：<blockquote>..</blockquote> → 每行前面加 > */
function convertBlockquote(html: string): string {
  return html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_whole, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
    if (!text) return "";
    return `\n\n${text
      .split(/\n+/)
      .map(line => `> ${line.trim()}`)
      .join("\n")}\n\n`;
  });
}

/** 列表：<li>..</li> → - ..；有序列表保留序号。 */
function convertLists(html: string): string {
  return html
    .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol\s*>/gi, (_whole, inner: string) => {
      let index = 1;
      return inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_w, item: string) => {
        const text = item.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
        if (!text) return "";
        const line = `${index}. ${text}\n`;
        index += 1;
        return line;
      });
    })
    .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/gi, (_whole, inner: string) =>
      inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_w, item: string) => {
        const text = item.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
        return text ? `- ${text}\n` : "";
      }),
    );
}

/** 段落与块级容器：去掉标签，保留内容，段落之间留空行。 */
function convertBlocks(html: string): string {
  return html
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi, (_w, inner: string) => `\n\n${inner.trim()}\n\n`)
    .replace(/<(div|section|article|header|footer|main|aside|figure|figcaption|ul|ol|table|tr|thead|tbody|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<\/(div|section|article|header|footer|main|aside|figure|figcaption|ul|ol|table|tr|thead|tbody|dl|dt|dd)\s*>/gi, "\n");
}

/** 分隔线。 */
function convertRules(html: string): string {
  return html.replace(/<hr\s*\/?\s*>/gi, "\n\n---\n\n");
}

/** 最后把剩下的标签（span 等）剥掉，只留文字。 */
function stripRemainingTags(html: string): string {
  return html.replace(/<\/?[a-z][^>]*>/gi, "");
}

/** 实体解码：常见的几个就够，公众号文章里主要是 &nbsp; &amp; &lt; &gt; &quot;。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 空白收拾：连续空行压成最多一个，段内多余空格压成一个，行尾去掉。 */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * HTML → Markdown。
 *
 * 只处理常见的公众号/网页标签，不是完整的 HTML 解析器——
 * 目标是「把文章内容捞干净」，不是像素级还原。
 */
export function htmlToMarkdown(html: string): string {
  let out = dropDangerousBlocks(html);
  out = convertImages(out);
  out = convertLinks(out);
  out = convertHeadings(out);
  out = convertBlockquote(out);
  out = convertLists(out);
  out = convertInline(out);
  out = convertRules(out);
  out = convertBlocks(out);
  out = stripRemainingTags(out);
  out = decodeEntities(out);
  return tidy(out);
}

/** 这段文字里有多少 HTML 标签？用来告诉用户「已经帮你洗过一遍了」。 */
export function countHtmlTags(text: string): number {
  const matches = text.match(/<\/?[a-z][^>]*>/gi);
  return matches ? matches.length : 0;
}

/**
 * 从文章里猜一个标题。
 *
 * 优先用第一个一级标题；没有就用第一行非空的文字。
 */
export function guessTitle(markdown: string, fallback = "未命名稿件"): string {
  const heading = markdown.match(/^\s*#\s+(.+?)\s*$/m);
  if (heading?.[1]) return heading[1].trim();
  const firstLine = markdown
    .split("\n")
    .map(line => line.trim())
    .find(line => line && !line.startsWith("![") && !line.startsWith(">"));
  if (!firstLine) return fallback;
  // 第一行可能是「## 小标题」这种，去掉井号再取。
  const cleaned = firstLine.replace(/^#+\s*/, "").trim();
  return cleaned.slice(0, 60) || fallback;
}
