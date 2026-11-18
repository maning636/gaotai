import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEqual, assertTrue, suite } from "./harness";
import { readExtensionInfo } from "../lib/bridge/extension-info";
import { isBridgeStateFresh } from "../lib/bridge/state";

/**
 * 插件安装指导的判定逻辑。
 *
 * 这两件事一旦判错，用户看到的就是假状态：明明没装却显示「已连接」，
 * 或者装好了却一直说「没找到插件文件」。所以单独测边界，而不是只靠点界面。
 */

function withExtensionDir<T>(setup: (dir: string) => void, run: (dir: string) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), "gaotai-ext-"));
  try {
    setup(root);
    const previous = process.env.GAOTAI_EXTENSION_DIR;
    process.env.GAOTAI_EXTENSION_DIR = root;
    try {
      return run(root);
    } finally {
      if (previous === undefined) delete process.env.GAOTAI_EXTENSION_DIR;
      else process.env.GAOTAI_EXTENSION_DIR = previous;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

suite("浏览器扩展信息", ({ test }) => {
  test("目录里有 manifest 且适配器完整时判定为可用", () => {
    withExtensionDir(
      (dir) => {
        writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "稿台多平台分发", version: "1.0.0" }));
        mkdirSync(path.join(dir, "platform-adapters"));
        for (const name of ["zhihu.js", "juejin.js", "types.js", "index.js", "_template.js"]) {
          writeFileSync(path.join(dir, "platform-adapters", name), "// stub");
        }
      },
      () => {
        const info = readExtensionInfo();
        assertTrue(info.available, "有 manifest 就应该判定为可用");
        assertEqual(info.version, "1.0.0");
        assertEqual(info.name, "稿台多平台分发");
        // types/index/_template 不是平台适配器，不能算进支持列表。
        assertEqual(info.adapters.join(","), "juejin,zhihu");
      },
    );
  });

  test("缺 manifest 的目录不算可用", () => {
    withExtensionDir(
      (dir) => {
        mkdirSync(path.join(dir, "platform-adapters"));
      },
      () => {
        const info = readExtensionInfo();
        assertTrue(!info.available, "没有 manifest 就不是可加载的扩展");
        assertEqual(info.adapters.length, 0);
      },
    );
  });

  test("manifest 损坏时不当成可用", () => {
    withExtensionDir(
      (dir) => {
        writeFileSync(path.join(dir, "manifest.json"), "{ 这不是 JSON");
      },
      () => {
        assertTrue(!readExtensionInfo().available, "manifest 解析失败应该降级为不可用");
      },
    );
  });
});

suite("桥接状态新鲜度", ({ test }) => {
  test("刚写入的状态算新鲜", () => {
    const now = 1_700_000_000_000;
    assertTrue(isBridgeStateFresh({ clients: 1, extensions: 1, tasks: 0, port: 9527, updatedAt: now - 5_000 }, now));
  });

  test("超过一分钟没刷新就认为过期", () => {
    const now = 1_700_000_000_000;
    assertTrue(!isBridgeStateFresh({ clients: 1, extensions: 1, tasks: 0, port: 9527, updatedAt: now - 61_000 }, now));
  });

  test("从未写入过的状态不算新鲜", () => {
    const now = 1_700_000_000_000;
    assertTrue(!isBridgeStateFresh({ clients: 0, extensions: 0, tasks: 0, port: 0, updatedAt: 0 }, now));
  });
});
