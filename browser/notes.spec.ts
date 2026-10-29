/**
 * #37、ADR 0005：Series Notes 累積與 Prior Pages。仿 Jump+ 的翻頁版，偵測＋OCR 是真的（wasm），FakeTranslator 整理
 * Notes（②）時在 p01 的 Balloon 裡看到「パン」就回傳成新增的條目；SW 的 __translateInputs 記下每次翻譯（①）送出的內容。
 */
import type { Worker } from '@playwright/test';
import type { NotesEntry } from '../src/shared/translator.ts';
import { activateOnJumpPlus, expect, readStore, test } from './fixtures.ts';

const パン = { 原文: 'パン', 讀音: 'ぱん', 譯文: '麵包', 類別: '用語' };

test.use({ viewport: null, fakeTranslator: true, fakeNotes: [パン] });

/** 第一次載入模型（從 mock site 下載＋wasm 編譯）加上一頁 OCR。 */
const FIRST_PAGE_TIMEOUT = 60_000;
/** 模型已載入後的一頁。 */
const PAGE_TIMEOUT = 30_000;

/** 每次翻譯送出時帶的 Series Notes（只看原文與譯文）。 */
const sentNotes = (sw: Worker) =>
  sw.evaluate(() => (globalThis.__translateInputs ?? []).map((input) => input.seriesNotes.map(({ 原文, 譯文 }) => ({ 原文, 譯文 }))));

/** 每次翻譯送出時帶的 Prior Pages 頁數。 */
const sentPriorPages = (sw: Worker) => sw.evaluate(() => (globalThis.__translateInputs ?? []).map((input) => input.priorPages.length));

test('第 1 頁背景整理出的條目，第 2 頁翻譯時就在 Series Notes 裡，也帶第 1 頁當 Prior Pages', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(FIRST_PAGE_TIMEOUT + PAGE_TIMEOUT);
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
  // 「已翻譯」＝譯文已顯示、快取已寫入；Notes（②）在背景整理，另外等
  await expect(panel.getByRole('status', { name: '翻譯狀態' })).toHaveText([/^已翻譯・/], { timeout: FIRST_PAGE_TIMEOUT });
  expect(await sentNotes(sw)).toEqual([[]]);
  await expect.poll(async () => (await readStore<NotesEntry>(sw, 'seriesNotes')).map((e) => e.原文)).toEqual(['パン']);

  // ← 鍵＝下一頁（RTL）
  await page.keyboard.press('ArrowLeft');

  await expect.poll(() => sentNotes(sw), { timeout: PAGE_TIMEOUT }).toEqual([[], [{ 原文: 'パン', 譯文: '麵包' }]]);
  expect(await sentPriorPages(sw)).toEqual([0, 1]);
});
