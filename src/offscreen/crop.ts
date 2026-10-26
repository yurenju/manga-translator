/**
 * 截圖裁切的座標換算（spec #27 第 3.2 節）。
 *
 * 倍率用「截圖像素 ÷ viewport 的 CSS px」直接算，不用 content script 回報的 devicePixelRatio：
 * 兩者理論上相等，但 DevTools／Playwright 模擬 DPR 時 devicePixelRatio 會跟實際截圖對不上。
 * pinch-zoom（visualViewport）還沒處理。
 */
import type { Rect, Size } from '../shared/messages.ts';
import type { RatioRect } from '../shared/page-text.ts';

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

/** 切頁結果（候選裁切裡的像素）→ 相對候選（anchor）的比例座標，覆蓋層與本機流水線共用。 */
export function toSubRect(page: Rect, candidate: Size): RatioRect {
  return { x: page.x / candidate.width, y: page.y / candidate.height, w: page.width / candidate.width, h: page.height / candidate.height };
}

/** 候選在截圖上的像素 rect 裡，sub 那一塊的像素 rect（各邊四捨五入，跟切頁時的整數像素一致）。 */
export function subImageRect(candidate: Rect, sub: RatioRect): Rect {
  const left = Math.round(sub.x * candidate.width);
  const top = Math.round(sub.y * candidate.height);
  const right = Math.round((sub.x + sub.w) * candidate.width);
  const bottom = Math.round((sub.y + sub.h) * candidate.height);
  return { x: candidate.x + left, y: candidate.y + top, width: right - left, height: bottom - top };
}
