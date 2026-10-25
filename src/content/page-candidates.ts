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

export function isPageCandidate(rect: Rect, viewport: Size): boolean {
  if (rect.width < MIN_PAGE_SIDE || rect.height < MIN_PAGE_SIDE) return false;
  return (
    rect.x >= -VIEWPORT_TOLERANCE &&
    rect.y >= -VIEWPORT_TOLERANCE &&
    rect.x + rect.width <= viewport.width + VIEWPORT_TOLERANCE &&
    rect.y + rect.height <= viewport.height + VIEWPORT_TOLERANCE
  );
}
