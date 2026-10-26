/**
 * 拼 HTML 用的几个小工具。
 *
 * 单独成文件，是因为它们同时被渲染器（markdown.ts）和排版模板（layout-template.ts）用，
 * 而模板这边是纯函数、不该反过来依赖解析器。
 */

/** HTML 转义。文本节点与属性值都要过一遍。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 拼装行内样式。
 *
 * 结果会被塞进双引号包裹的 style 属性，所以必须先做一次属性级转义——
 * 字体栈、用户可影响的内容里只要有一个双引号，属性就会被提前截断，
 * 后面的内容全部变成正文文本。
 */
export function styleText(props: Record<string, string | number>): string {
  return Object.entries(props)
    .map(([key, value]) => `${key}: ${value};`)
    .join(" ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 代码块正文。
 *
 * 公众号编辑器不保证保留 <pre> 的空白样式——原始换行到了公众号里可能塌成一行。
 * 所以这里把换行显式换成 <br />，让"原始换行"这件事不依赖平台对空白样式的处理。
 * 转义在前、换行在后：转义不会动换行符，而换行替换出来的 <br /> 是我们自己加的标签。
 */
export function codeBlockText(value: string): string {
  return escapeHtml(value).replace(/\r\n?/g, "\n").replace(/\n/g, "<br />");
}
