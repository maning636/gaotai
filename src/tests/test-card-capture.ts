import { assertEqual, assertTrue, suite } from "./harness";
import { createOffscreenContainer, removeOffscreenContainer, cleanupAllOffscreenContainers } from "../lib/card/offscreen";
import { exportCards, exportedSuccessCount, exportedFailCount } from "../lib/card/exporter";

/**
 * 卡片截图相关测试。
 *
 * modern-screenshot 需要真实 DOM 环境，测试里不实际截图，
 * 只用 jsdom 测离屏容器的创建/清理，用依赖注入的 capture 测导出器进度回调。
 * 若 jsdom 不可用（本机没装），离屏测试自动跳过——逻辑测试不受影响。
 */

/** 用 jsdom 建立最小 DOM 环境，返回恢复函数。 */
function setupDom(): (() => void) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require("jsdom") as { JSDOM: new (html: string) => { window: Window & typeof globalThis; document: Document } };
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const g = globalThis as Record<string, unknown>;
    const prevDoc = g.document;
    const prevWin = g.window;
    g.document = dom.window.document;
    g.window = dom.window;
    return () => {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
      if (prevWin === undefined) delete g.window;
      else g.window = prevWin;
    };
  } catch {
    return null;
  }
}

suite("卡片截图：离屏容器", ({ test }) => {
  const restore = setupDom();
  const hasDom = restore !== null;

  test("创建离屏容器挂到 body 且带离屏定位", () => {
    if (!hasDom) {
      assertTrue(true, "无 jsdom，跳过");
      return;
    }
    const container = createOffscreenContainer();
    assertEqual(container.style.position, "fixed");
    assertEqual(container.style.visibility, "hidden");
    assertEqual(container.style.left, "-9999px");
    assertEqual(container.parentNode, document.body);
    removeOffscreenContainer(container);
  });

  test("清理后从 DOM 移除", () => {
    if (!hasDom) {
      assertTrue(true, "无 jsdom，跳过");
      return;
    }
    const container = createOffscreenContainer();
    removeOffscreenContainer(container);
    assertEqual(container.parentNode, null);
    assertEqual(document.querySelectorAll("[data-card-offscreen]").length, 0);
  });

  test("批量清理移除所有离屏容器", () => {
    if (!hasDom) {
      assertTrue(true, "无 jsdom，跳过");
      return;
    }
    createOffscreenContainer();
    createOffscreenContainer();
    assertEqual(document.querySelectorAll("[data-card-offscreen]").length, 2);
    cleanupAllOffscreenContainers();
    assertEqual(document.querySelectorAll("[data-card-offscreen]").length, 0);
  });

  if (restore) restore();
});

suite("卡片截图：导出器", ({ test }) => {
  test("进度回调按页触发", async () => {
    const calls: number[] = [];
    const pages = [{} as HTMLElement, {} as HTMLElement, {} as HTMLElement];
    const results = await exportCards(pages, {
      onProgress: (i, total) => calls.push(i + total * 10),
      capture: async () => "data:image/png;base64,AAAA",
    });
    assertEqual(calls.length, 3);
    assertEqual(calls, [30, 31, 32]);
    assertEqual(results.length, 3);
    assertEqual(exportedSuccessCount(results), 3);
  });

  test("失败页标记继续，不中断整批", async () => {
    const pages = [{} as HTMLElement, {} as HTMLElement, {} as HTMLElement];
    const results = await exportCards(pages, {
      capture: async (root) => {
        if (root === pages[1]) throw new Error("boom");
        return "data:image/png;base64,BBBB";
      },
    });
    assertEqual(results.length, 3);
    assertEqual(results[0].url, "data:image/png;base64,BBBB");
    assertEqual(results[1].url, null);
    assertEqual(results[1].error, "boom");
    assertEqual(results[2].url, "data:image/png;base64,BBBB");
    assertEqual(exportedSuccessCount(results), 2);
    assertEqual(exportedFailCount(results), 1);
  });

  test("全失败时成功计数为 0", async () => {
    const results = await exportCards([{} as HTMLElement, {} as HTMLElement], {
      capture: async () => {
        throw new Error("no dom");
      },
    });
    assertEqual(exportedSuccessCount(results), 0);
    assertEqual(exportedFailCount(results), 2);
  });
});
