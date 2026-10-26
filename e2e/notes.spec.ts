/**
 * #37：Series Notes 累積。仿 Jump+ 的翻頁版，偵測＋OCR 是真的（wasm），FakeTranslator 在 p01 的 Balloon 裡看到
 * 「パン」就回傳成新增的條目；SW 的 __translateInputs 記下每次送出的內容。
 */
import type { Worker } from '@playwright/test';
import { activateOnJumpPlus, expect, test } from './fixtures.ts';

const パン = { 原文: 'パン', 讀音: 'ぱん', 譯文: '麵包', 類別: '用語' };

test.use({ viewport: null, fakeTranslator: true, fakeNotes: [パン] });

/** 第一次載入模型（從 mock site 下載＋wasm 編譯）加上一頁 OCR。 */
const FIRST_PAGE_TIMEOUT = 60_000;
/** 模型已載入後的一頁。 */
const PAGE_TIMEOUT = 30_000;

/** 每次送出時帶的 Series Notes（只看原文與譯文）。 */
const sentNotes = (sw: Worker) =>
  sw.evaluate(() => (globalThis.__translateInputs ?? []).map((input) => input.seriesNotes.map(({ 原文, 譯文 }) => ({ 原文, 譯文 }))));

test('第 1 頁 LLM 新增的條目，第 2 頁送出時就在 Series Notes 裡', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(FIRST_PAGE_TIMEOUT + PAGE_TIMEOUT);
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
  // 「已翻譯」＝這頁的 notes_changes 已套用、快取已寫入
  await expect(panel.getByRole('status', { name: '翻譯狀態' })).toHaveText([/^已翻譯・/], { timeout: FIRST_PAGE_TIMEOUT });
  expect(await sentNotes(sw)).toEqual([[]]);

  // ← 鍵＝下一頁（RTL）
  await page.keyboard.press('ArrowLeft');

  await expect.poll(() => sentNotes(sw), { timeout: PAGE_TIMEOUT }).toEqual([[], [{ 原文: 'パン', 譯文: '麵包' }]]);
});
