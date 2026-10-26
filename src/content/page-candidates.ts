/**
 * Page 候選的判斷（ADR 0003、spec #27 第 3.2 節）。只看 getBoundingClientRect()，不碰 DOM，方便單元測試。
 */
import type { Rect, Size } from '../shared/messages.ts';

/**
 * 「夠大」的門檻：寬高都至少這麼多 CSS px。
 * 量測：仿 Jump+ 在 1280×720 的視窗裡每頁顯示成 430×625（合成頁 880×1280 的 0.49×）；
 * Kindle 是整個 viewport 一張圖。網站上的圖示、頭像、縮圖列通常在 150 px 以下。
 * 取 200 讓窄視窗（Jump+ 約 300 px 寬）仍然認得到，又能排掉小圖。
 */
export const MIN_PAGE_SIDE = 200;

/** 超出 viewport 這麼多 CSS px 內仍算完整可見（四捨五入、邊框、捲動停在半像素）。 */
export const VIEWPORT_TOLERANCE = 4;

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - VIEWPORT_TOLERANCE &&
  inner.y >= outer.y - VIEWPORT_TOLERANCE &&
  inner.x + inner.width <= outer.x + outer.width + VIEWPORT_TOLERANCE &&
  inner.y + inner.height <= outer.y + outer.height + VIEWPORT_TOLERANCE;

/**
 * clips＝會裁切內容的祖先（overflow 不是 visible）的 rect：翻頁式 viewer 把隔壁頁放在裁切範圍外，
 * getBoundingClientRect 看不出來，要完整落在每一個裡面才算可見。
 */
export function isPageCandidate(rect: Rect, viewport: Size, clips: readonly Rect[] = []): boolean {
  if (rect.width < MIN_PAGE_SIDE || rect.height < MIN_PAGE_SIDE) return false;
  return contains({ x: 0, y: 0, ...viewport }, rect) && clips.every((clip) => contains(clip, rect));
}
