// ESLint flat config（ESM）。
//
// 定位：硬门只拦「会变成 bug 的东西」——未使用变量/导入、明显错误、
// 类型逃逸（any）。纯排版风格不做要求（本仓库没有 formatter 约定，
// 强行引入会把 373 条测试之外的改动面扩大到全仓）。
//
// 基线：@eslint/js recommended + typescript-eslint recommended（非 type-checked）。
// 不用 type-checked 的原因：它要求每个文件都在 tsconfig 的 project 里，
// 而 electron/*.js（CommonJS）、scripts/*.mjs 不在其中；用 projectService
// 会让 lint 耗时翻倍且对脚本类文件始终报 parsing error。类型正确性由
// `npm run typecheck`（tsc --noEmit，strict）单独守，两道门不重叠也不留空。
//
// 全局变量：不引入 `globals` 包（deps-gate 不扫描本文件，装了会被判「声明但
// 零引用」），改为在这里显式声明两份最小集合。宁可少列也不列错——TS 侧
// `no-undef` 由 typescript-eslint 关掉（类型系统接管），这里的 globals 只对
// electron 的 CJS 脚本和 scripts/*.mjs 真正起作用。
//
// 待收紧清单（下列开关是「当前必须收窄」而不是「永久放弃」，动之前先看影响面）：
// 1. @typescript-eslint/no-require-imports —— 只对 electron/**/*.js 关闭。
//    根目录没有 "type": "module"，主进程/preload 必须是 CJS；要收紧得先改
//    打包与加载链路（electron-builder 入口），不在 lint 层。
// 2. no-undef —— 只对 **/*.ts?(x) 关闭，交给 tsc strict 兜。想恢复需先确认
//    TS 里没有纯类型引用误报（typescript-eslint 官方也建议在 TS 上关掉它）。
// 3. no-control-regex —— 只在 src/lib/files.ts 两处行级禁用（清洗 Windows
//    非法文件名字符，属于有意为之），没有整文件/整目录 disable。
// 4. 尚未启用、值得后续补的：typescript-eslint type-checked 规则（需要把
//    electron/scripts 纳入 tsconfig project，见上面「基线」一段的理由）。
//    eslint-plugin-react-hooks 已启用（见文件末尾 gaotai/react-hooks 配置块）。
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/** Node 运行时全局（electron 主进程 / 打包脚本 / 检查脚本）。 */
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  global: "readonly",
  globalThis: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  module: "writable",
  require: "readonly",
  exports: "writable",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  queueMicrotask: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  structuredClone: "readonly",
  fetch: "readonly",
};

/** 浏览器全局（React 组件 / 客户端 fetch）。 */
const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  location: "readonly",
  history: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  alert: "readonly",
  confirm: "readonly",
  prompt: "readonly",
  event: "readonly",
  HTMLElement: "readonly",
  HTMLInputElement: "readonly",
  HTMLTextAreaElement: "readonly",
  HTMLDivElement: "readonly",
  HTMLButtonElement: "readonly",
  HTMLImageElement: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  KeyboardEvent: "readonly",
  MouseEvent: "readonly",
  DragEvent: "readonly",
  DataTransfer: "readonly",
  File: "readonly",
  FileList: "readonly",
  FileReader: "readonly",
  Blob: "readonly",
  FormData: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
  Image: "readonly",
  Node: "readonly",
  Element: "readonly",
  MutationObserver: "readonly",
  ResizeObserver: "readonly",
  IntersectionObserver: "readonly",
  getComputedStyle: "readonly",
  matchMedia: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  atob: "readonly",
  btoa: "readonly",
  fetch: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  structuredClone: "readonly",
  console: "readonly",
};

export default tseslint.config(
  {
    name: "gaotai/ignores",
    ignores: [
      "node_modules/**",
      ".next/**",
      "release/**",
      "dist/**",
      ".tmp/**",
      "data/**",
      "images/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: "gaotai/base",
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
  },
  {
    // TypeScript 源码（页面 + API 路由 + 领域层 + 测试）：
    // - 两类全局都要：服务端代码用 process/Buffer，客户端组件用 window/document；
    // - no-undef 交给 tsc（strict）——类型系统已经接管未定义标识符，
    //   在 TS 上重复检查只会对纯类型引用产生误报（typescript-eslint FAQ 同款结论）。
    name: "gaotai/typescript",
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } },
    rules: {
      "no-undef": "off",
    },
  },
  {
    // electron 主进程 / preload：项目根没有 "type": "module"，CJS 是硬约束
    // （AGENT.md 与 electron/main.js 头部注释都写明了）。
    // 因此这里只关掉「禁止 require」这一条，其余规则照常生效；
    // 换成 ESM 会直接改变打包产物的加载方式，不属于 lint 能顺手改的范围。
    name: "gaotai/electron-cjs",
    files: ["electron/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: nodeGlobals },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // 打包/检查脚本与 next.config.ts：ESM + 纯 Node 运行时，
    // 不注入浏览器全局，避免脚本里误写 window 却能过 lint。
    name: "gaotai/scripts",
    files: ["scripts/**/*.mjs", "scripts/**/*.mts", "next.config.ts"],
    languageOptions: { sourceType: "module", globals: nodeGlobals },
  },
  {
    // React hooks 规则：rules-of-hooks（调用顺序）+ exhaustive-deps（依赖数组）。
    // 这是唯一能机器验证「effect 该不该重跑」的检查——login/page.tsx 的
    // 空依赖数组曾经只能靠注释说明。
    //
    // 以下两条 React Compiler 就绪类规则在此关闭（属于「优化建议」而非运行期
    // 正确性，列入待收紧清单）：
    // - set-state-in-effect：挂载时同步初始化状态是本项目普遍且正确的模式
    //   （能力检测 window.gaotai、读 localStorage），改 useSyncExternalStore
    //   或惰性初始化需要重写组件，不在 lint 层顺手改。
    // - purity：概览页是 Server Component，渲染期读 Date.now() 合法；
    //   规则按客户端组件的纯函数假设判定，对本项目是误报。
    name: "gaotai/react-hooks",
    files: ["src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
    },
  },
);
