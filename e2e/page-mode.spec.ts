/**
 * #73 Page Mode（閱讀／學習）：全域記住，學習時頁面保留日文原稿。偵測＋OCR 是真的（wasm），譯文來自 FakeTranslator。
 * 頁面上的內容與 hover 在 overlay.spec.ts、learning.spec.ts；這裡是記住設定、學習時認頁。
 */
import type { Page, Worker } from '@playwright/test';
import { activateOnJumpPlus, expect, openSidePanel, test } from './fixtures.ts';
import { overlayTexts, pageMode, shownTranslations } from './overlay-helpers.ts';

test.use({ viewport: null, fakeTranslator: true });

/** 第一次載入模型＋OCR。 */
const FIRST_PAGE_TIMEOUT = 60_000;
/** 模型已載入後的一頁。 */
const PAGE_TIMEOUT = 30_000;

const translateCalls = (sw: Worker) => sw.evaluate(() => globalThis.__translateCalls ?? 0);
const captureCount = (sw: Worker) => sw.evaluate(() => globalThis.__captureLog?.length ?? 0);
const statusLines = (panel: Page) => panel.getByRole('status', { name: '翻譯狀態' });

test('Page Mode 在重開 side panel、新分頁啟動後沿用', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(FIRST_PAGE_TIMEOUT + 2 * PAGE_TIMEOUT);
  const first = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await pageMode(first.panel, '學習').click();
  await expect(pageMode(first.panel, '學習')).toHaveAttribute('aria-pressed', 'true');

  // 重開 side panel
  await first.panel.close();
  const reopened = await openSidePanel(context, extensionId, first.tabId);
  await expect(pageMode(reopened, '學習')).toHaveAttribute('aria-pressed', 'true');
  await reopened.close();

  // 新分頁啟動：翻好後頁面上有覆蓋層（hover 要用），但看不到譯文
  const second = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
  await expect(pageMode(second.panel, '學習')).toHaveAttribute('aria-pressed', 'true');
  await expect(statusLines(second.panel)).toHaveText([/^已翻譯・/], { timeout: FIRST_PAGE_TIMEOUT });
  await expect.poll(async () => (await overlayTexts(second.page)).length, { timeout: PAGE_TIMEOUT }).toBeGreaterThan(0);
  await expect(shownTranslations(second.page)).toHaveCount(0);

  // 在新分頁切回閱讀：所有分頁共用，第一個分頁也跟著顯示譯文
  await pageMode(second.panel, '閱讀').click();
  await expect(shownTranslations(second.page)).not.toHaveCount(0);
  await expect(shownTranslations(first.page)).not.toHaveCount(0);
});

test('學習時重新擷取同一頁不會重翻；翻頁後翻新的一頁、翻回來命中快取', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(FIRST_PAGE_TIMEOUT + 3 * PAGE_TIMEOUT);
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/], { timeout: FIRST_PAGE_TIMEOUT });
  await pageMode(panel, '學習').click();
  await expect(shownTranslations(page)).toHaveCount(0);
  expect(await translateCalls(sw)).toBe(1);

  // 重新擷取：頁面上沒蓋東西，截到原稿也認得出同一頁
  const captures = await captureCount(sw);
  await panel.getByRole('button', { name: '重新擷取' }).click();
  await expect.poll(() => captureCount(sw)).toBeGreaterThan(captures);
  await page.waitForTimeout(1_000);
  expect(await translateCalls(sw)).toBe(1);
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/]);

  // 翻頁（← 是下一頁）：新的一頁照常翻譯；翻回來命中快取
  await page.bringToFront();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => translateCalls(sw), { timeout: PAGE_TIMEOUT }).toBe(2);
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/], { timeout: PAGE_TIMEOUT });
  await page.keyboard.press('ArrowRight');
  await expect(statusLines(panel)).toHaveText([/^快取・/], { timeout: PAGE_TIMEOUT });
  expect(await translateCalls(sw)).toBe(2);
  await expect(shownTranslations(page)).toHaveCount(0);
});
