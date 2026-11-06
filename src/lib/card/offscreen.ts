/**
 * 离屏容器。
 *
 * 卡片截图前先把页面元素挂进一个不可见的离屏容器里，确保它有真实尺寸
 * （`position:fixed + visibility:hidden + left:-9999px`）。
 * 禁用 `display:none`——那会让元素没有布局尺寸，截图会拿不到内容。
 *
 * 浏览器端专用，Node 环境不可引。
 */

/** 创建离屏容器并挂到 document.body。 */
export function createOffscreenContainer(): HTMLDivElement {
  const container = document.createElement("div");
  container.dataset.cardOffscreen = "1";
  container.style.position = "fixed";
  container.style.visibility = "hidden";
  container.style.left = "-9999px";
  container.style.top = "0";
  container.style.zIndex = "-1";
  container.style.pointerEvents = "none";
  document.body.appendChild(container);
  return container;
}

/** 截图完成后清理离屏容器。 */
export function removeOffscreenContainer(el: HTMLElement): void {
  if (el && el.parentNode) {
    el.parentNode.removeChild(el);
  }
}

/** 清掉页面上所有残留的离屏容器（容错，避免泄漏）。 */
export function cleanupAllOffscreenContainers(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-card-offscreen]"))) {
    el.remove();
  }
}
