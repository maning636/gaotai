/**
 * 卡片批量导出。
 *
 * 串行逐页截图 → PNG dataURL，失败页标记继续，不中断整批。
 * 进度回调把「第几张 / 共几张」告诉界面。
 *
 * 浏览器端专用：依赖 capture.ts（modern-screenshot）。
 */

import { capturePageToDataUrl } from "./capture";

/** 导出选项。 */
export type ExportCardsOptions = {
  /** 截图缩放（默认 2）。 */
  scale?: number;
  /** 每页开始/完成时的进度回调（index 从 0 起）。 */
  onProgress?: (index: number, total: number) => void;
  /**
   * 单页截图函数（测试注入用，缺省用 capturePageToDataUrl）。
   * 返回 PNG dataURL。
   */
  capture?: (root: HTMLElement, scale: number) => Promise<string>;
};

/** 单页导出结果。 */
export type ExportedPage = {
  index: number;
  /** PNG dataURL；失败时为 null。 */
  url: string | null;
  /** 失败原因。 */
  error?: string;
};

/**
 * 逐页截图导出。
 *
 * 串行执行保证页面稳定（避免并行截图相互干扰），
 * 任一页失败只标记该页，继续导出剩余页。
 */
export async function exportCards(
  pages: HTMLElement[],
  options: ExportCardsOptions = {},
): Promise<ExportedPage[]> {
  const scale = options.scale ?? 2;
  const total = pages.length;
  const results: ExportedPage[] = [];
  const capture = options.capture ?? capturePageToDataUrl;

  for (let i = 0; i < total; i += 1) {
    const root = pages[i];
    try {
      const url = await capture(root, scale);
      results.push({ index: i, url });
    } catch (error) {
      results.push({
        index: i,
        url: null,
        error: error instanceof Error ? error.message : "导出失败",
      });
    }
    options.onProgress?.(i, total);
  }

  return results;
}

/** 统计成功导出的页数。 */
export function exportedSuccessCount(results: ExportedPage[]): number {
  return results.filter(item => item.url !== null).length;
}

/** 统计失败页数。 */
export function exportedFailCount(results: ExportedPage[]): number {
  return results.length - exportedSuccessCount(results);
}
