// deps-gate：依赖声明闸门。
//
// 做两件事（对照 engineering-standard §2.2 的 Node 版）：
//   1. 正向：扫描 src/ electron/ scripts/ 下的 import/require，
//      与 package.json 声明对齐——引用了未声明的第三方包即报错。
//   2. 反向：声明了但全仓零引用的包报冗余（cheerio/dotenv 就是这么抓出来的）。
//
// 为什么不用 AST：tsc 的 --noEmit 已经保证了语法正确性，这里只需要
// 模块说明符，正则足够且零依赖（闸门自身不引入依赖漂移面）。
// 排除 type-only import 缺声明：纯类型引用不需要运行时实体（mdast 由
// @types/mdast 供给）；但 import type 引用的包若完全没声明也不报，
// 因为类型包与运行时包的映射关系无法静态判定。
//
// 自测：src/tests/deps-gate.test.ts 构造临时工程验证各分支；
// 闸门若「永远返回 OK」，测试会红（反向自测防假闸门，坑 C4 同型）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const SCAN_DIRS = ["src", "electron", "scripts"];
const SCAN_EXT = [".ts", ".tsx", ".mts", ".mjs", ".js"];

/** 递归收集目录下指定扩展名的文件。 */
function collectFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) collectFiles(full, out);
    else if (SCAN_EXT.includes(path.extname(name))) out.push(full);
  }
  return out;
}

/** 从源码文本提取模块说明符（import / import type / export from / require）。
 *  模板字符串内的 require("${...}") 是运行时生成的 shim 代码，不是真引用，
 *  先把它们挖掉再匹配（否则 copy-standalone-assets.mjs 的 shim 会误报）。 */
function extractSpecs(code: string): string[] {
  const cleaned = code
    .replace(/`[^`]*`/gs, (m) => " ".repeat(m.length)) // 整段模板字符串
    .replace(/^\s*\/\/.*$/gm, (m) => " ".repeat(m.length)) // 整行注释
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)); // 块注释
  const specs: string[] = [];
  const patterns = [
    /import\s+type\s+[^"']*from\s+["']([^"']+)["']/g, // import type ... from "x"
    /import\s+[^"';]*?from\s+["']([^"']+)["']/g, // import ... from "x"
    /import\s+["']([^"']+)["']/g, // import "x"（副作用导入）
    /export\s+[^"';]*?from\s+["']([^"']+)["']/g, // export ... from "x"
    /require\(\s*["']([^"']+)["']\s*\)/g, // require("x")
    /import\(\s*["']([^"']+)["']\s*\)/g, // 动态 import("x")——按需加载也算真引用
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** 说明符 → 第三方包名；内置/相对/Node: 前缀返回 null。 */
function packageNameOf(spec: string): string | null {
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null; // 相对/绝对
  // tsconfig 的 @/* 别名指向 src/*，它不是 npm 包；当成包会报「未声明」。
  if (spec.startsWith("@/")) return null;
  if (spec.startsWith("node:")) return null; // Node 内置（显式前缀）
  const parts = spec.split("/");
  // @scope/name 取前两段；裸包名取第一段；node: 内置在 ts 里也可能裸写
  const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!pkg.startsWith("@") && isNodeBuiltin(pkg)) return null;
  return pkg;
}

const builtins = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
  "test", "http2", "diagnostics_channel",
]);
function isNodeBuiltin(name: string): boolean {
  return builtins.has(name);
}

export type DepProblem = {
  kind: "undeclared" | "unused";
  spec: string;
  where?: string;
};

export type ScanResult = {
  problems: DepProblem[];
  declared: string[];
  referenced: Map<string, string[]>;
};

/** 扫描一个工程根目录，返回依赖覆盖问题。测试与 CLI 共用此入口。 */
export function scanDependencyCoverage(root: string): ScanResult {
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const declared = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);

  // electron/next 等构建工具链入口不算「冗余」：electron 由 npm run desktop
  // 命令行消费、next 由 next 命令消费，不在 import 里出现是正常的。
  // react-dom 由 react/jsx-runtime 在编译产物中隐式引用，同理。
  const cliOnlyAllow = new Set(["electron", "electron-builder", "next", "tsx", "typescript", "eslint", "@eslint/js", "typescript-eslint", "react-dom", "eslint-plugin-react-hooks"]);

  const referenced = new Map<string, string[]>();
  const problems: DepProblem[] = [];

  for (const dir of SCAN_DIRS) {
    for (const file of collectFiles(path.join(root, dir))) {
      const rel = path.relative(root, file).replaceAll("\\", "/");
      const code = readFileSync(file, "utf8");
      const isTypeOnly = (spec: string) =>
        new RegExp(`import\\s+type\\s+[^"']*from\\s+["']${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(code);
      for (const spec of extractSpecs(code)) {
        const pkg = packageNameOf(spec);
        if (!pkg) continue;
        if (!declared.has(pkg) && !isTypeOnly(spec)) {
          problems.push({ kind: "undeclared", spec: pkg, where: rel });
        }
        if (!referenced.has(pkg)) referenced.set(pkg, []);
        referenced.get(pkg)!.push(rel);
      }
    }
  }

  for (const dep of declared) {
    if (cliOnlyAllow.has(dep)) continue;
    // @types/X 是 X 的类型供给：X（运行时包）被引用即视为 @types/X 已用；
    // @types/node 对应 Node 内置能力、@types/react-dom 对应 JSX 运行时隐式引用，
    // 都不以模块说明符形式出现，显式豁免。
    if (dep === "@types/node" || dep === "@types/react-dom") continue;
    if (dep.startsWith("@types/")) {
      const runtime = dep.slice("@types/".length);
      if (referenced.has(runtime) || referenced.has(dep)) continue;
    }
    if (!referenced.has(dep)) problems.push({ kind: "unused", spec: dep });
  }

  return { problems, declared: [...declared], referenced };
}

// ---- CLI 入口（node --experimental-strip-types scripts/check-deps-coverage.mts 或 tsx）----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = scanDependencyCoverage(projectRoot);
  if (result.problems.length > 0) {
    console.error("deps-gate：发现依赖声明问题：");
    for (const p of result.problems) {
      if (p.kind === "undeclared") console.error(`  [缺失] ${p.spec}（${p.where} 引用但未声明）`);
      else console.error(`  [冗余] ${p.spec}（已声明但全仓零引用）`);
    }
    process.exit(1);
  }
  console.log(`deps-gate：干净（${result.declared.length} 个声明与引用全部对齐）`);
}
