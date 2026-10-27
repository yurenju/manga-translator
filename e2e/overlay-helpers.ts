/** 覆蓋層的 e2e 共用量測。覆蓋層在 open shadow root 裡（[data-naruhodo-overlay] 是 shadow host）。 */
import type { Locator, Page } from '@playwright/test';

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayText {
  /** Balloon id。 */
  id: string;
  text: string;
  /** 譯文元素在畫面上的 rect（含 Page 層的 scale 與祖先 transform）。 */
  rect: ScreenRect;
  /** 長字的第幾階（spec 第 7.4 節）。 */
  fit: number;
  /** 畫面上的字級：Page 像素的 font-size × Page 層的倍率。 */
  screenFontPx: number;
}

/** 頁面上所有覆蓋層的譯文元素。 */
export function overlayTexts(page: Page): Promise<OverlayText[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-naruhodo-overlay]')].flatMap((host) =>
      [...host.shadowRoot!.querySelectorAll<HTMLElement>('[data-balloon-id]')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.dataset.balloonId!,
          text: el.textContent ?? '',
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          fit: Number(el.dataset.fit),
          // offsetWidth 會取整數，用 inline style 的精確寬度算 Page 層倍率
          screenFontPx: parseFloat(getComputedStyle(el).fontSize) * (r.width / parseFloat(el.style.width)),
        };
      }),
    ),
  );
}

/** 頁面上看得到的譯文元素（Playwright 的 locator 會穿進 open shadow root）。 */
export const shownTranslations = (page: Page): Locator => page.locator('[data-naruhodo-overlay] [data-balloon-id]').filter({ visible: true });

/** 頁面上看得到的擦字底色。 */
export const shownErasers = (page: Page): Locator => page.locator('[data-naruhodo-overlay] .er').filter({ visible: true });

/** side panel 的 Page Mode 切換（閱讀／學習）。 */
export const pageMode = (panel: Page, name: '閱讀' | '學習'): Locator =>
  panel.getByRole('group', { name: '頁面模式' }).getByRole('button', { name, exact: true });

/** 頁面上有幾個覆蓋層的 shadow host。 */
export function overlayHostCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-naruhodo-overlay]').length);
}
