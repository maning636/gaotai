/**
 * 卡片截图层。
 *
 * 用 modern-screenshot 的 `domToBlob` 把 DOM 节点截成 PNG Blob / dataURL。
 * 浏览器端专用：modern-screenshot 依赖 DOM，Node 环境不可引。
 *
 * 截图前应把目标元素挂进离屏容器（offscreen.ts），
 * 否则元素若无布局尺寸会截出空白。
 */

import { domToBlob } from "modern-screenshot";

/** 默认截图缩放。 */
export const DEFAULT_CAPTURE_SCALE = 2;

/**
 * 把 DOM 节点截成 PNG Blob。
 *
 * @param root 要截图的根元素
 * @param scale 像素密度缩放（默认 2，保证导出清晰）
 */
export async function capturePage(root: HTMLElement, scale: number = DEFAULT_CAPTURE_SCALE): Promise<Blob> {
  const blob = await domToBlob(root, {
    scale,
    backgroundColor: "#ffffff",
    width: root.scrollWidth || undefined,
    height: root.scrollHeight || undefined,
  });
  if (!blob) throw new Error("截图失败：domToBlob 返回空。");
  return blob;
}

/** 把 DOM 节点截成 PNG dataURL（data:image/png;base64,...）。 */
export async function capturePageToDataUrl(
  root: HTMLElement,
  scale: number = DEFAULT_CAPTURE_SCALE,
): Promise<string> {
  const blob = await capturePage(root, scale);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取截图 Blob 失败。"));
    reader.readAsDataURL(blob);
  });
}
