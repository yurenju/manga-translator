/**
 * 截圖裁切的座標換算（spec #27 第 3.2 節）。
 *
 * 倍率用「截圖像素 ÷ viewport 的 CSS px」直接算，不用 content script 回報的 devicePixelRatio：
 * 兩者理論上相等，但 DevTools／Playwright 模擬 DPR 時 devicePixelRatio 會跟實際截圖對不上。
 * pinch-zoom（visualViewport）還沒處理。
 */
import type { Rect, Size } from '../shared/messages.ts';

/** CSS rect → 截圖上的整數像素 rect，夾在截圖範圍內。 */
export function toImageRect(rect: Rect, viewport: Size, image: Size): Rect {
  const sx = image.width / viewport.width;
  const sy = image.height / viewport.height;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  // 四個邊各自四捨五入，相鄰的 Page 不會因為各自取整而重疊或留縫。
  const left = clamp(Math.round(rect.x * sx), image.width);
  const top = clamp(Math.round(rect.y * sy), image.height);
  const right = clamp(Math.round((rect.x + rect.width) * sx), image.width);
  const bottom = clamp(Math.round((rect.y + rect.height) * sy), image.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 縮到最多 maxWidth 寬、保持比例；不放大。 */
export function thumbnailSize(size: Size, maxWidth: number): Size {
  if (size.width <= maxWidth) return size;
  return { width: maxWidth, height: Math.round((size.height * maxWidth) / size.width) };
}
