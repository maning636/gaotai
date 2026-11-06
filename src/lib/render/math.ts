import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";

/**
 * LaTeX 公式 → 自包含 SVG。
 *
 * 稿台渲染的结果要粘进公众号编辑器。公众号不认 MathJax 的运行时脚本，
 * 也不保证外部样式表能进来，所以这里直接用 mathjax-full 的 TeX → SVG 管线，
 * 把公式转成一段**自包含**的 `<svg>`：路径、颜色、字体都内联在 SVG 里，
 * 不依赖任何外部 CSS/JS。公众号编辑器对 `<svg>` 标签不清洗，公式能原样存活。
 *
 * 只在 Node 端用：mathjax-full 体积大，塞进浏览器 bundle 会拖垮首屏。
 * 调用方（API 路由 / 服务器端渲染）负责保证这点。
 */

// 高频核心宏包。只引这些：
//  - base/ams：最常用（上下标、分式、矩阵、定理环境）。
//  - newcommand：`\newcommand` / `\def`，用户常拿来定义自己的符号。
//  - noerrors/noundefined：公式写错时不给整篇渲染报错，退化成"尽力渲染"。
//  - ams_errors：与上面配套，把 ams 环境的错误也兜住。
//  - bbox/centernot/color/colv2/fontspec/mhchem/physics：常见扩展。
// 不引 full 包：那会拖慢初始化，也会把用不到的宏塞进 bundle。
const TEX_PACKAGES = [
  "base",
  "ams",
  "newcommand",
  "noerrors",
  "noundefined",
  "ams_errors",
  "bbox",
  "centernot",
  "color",
  "colorv2",
  "fontspec",
  "mhchem",
  "physics",
];

// 字体缓存用 local：SVG 里的字体路径内联到输出里（而不是引用外部 url(#)），
// 这样 SVG 单独拎出来也能正确显示。
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({ packages: TEX_PACKAGES });
const svg = new SVG({ fontCache: "local" });

// 单个 document 复用：mathjax 的转换不依赖 document 内容，全局建一次，
// 避免每次渲染都重建 InputJax/OutputJax（初始化很贵）。
const doc = mathjax.document("", { InputJax: tex, OutputJax: svg });

/**
 * 渲染一条 LaTeX 公式，返回自包含的 `<svg>` 字符串。
 *
 * @param formula 公式体（不含 `$` 定界符）。
 * @param displayMode true = 块级（`$$...$$`），false = 行内（`$...$`）。
 * @returns 可直接嵌进 HTML 的 SVG。解析失败时返回空串（调用方兜底成公式原文）。
 */
export function renderMath(formula: string, displayMode: boolean): string {
  try {
    const node = doc.convert(formula, {
      display: displayMode,
      em: 16,
      ex: 8,
      containerWidth: 80,
    });
    // innerHTML 就是 <svg>...</svg>：container 只是 <mjx-container> 包装。
    // 微信不认 mjx-container 也没关系，我们要的就是里面的 svg 本体。
    return adaptor.innerHTML(node);
  } catch {
    // 公式写错不该让整篇渲染挂掉——返回空串，调用方退化成原文。
    return "";
  }
}
