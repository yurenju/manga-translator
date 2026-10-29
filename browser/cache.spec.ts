/**
 * #33：Page 身分與翻譯快取的串接。用 FakeTranslator（SW 的 __translateCalls 記被呼叫幾次）。
 * 仿 Jump+ 啟動時第 1、2 頁完整可見，所以每次擷取是兩個 Page。
 * 快取命中、Provisional Series 與快取 ID 的規則在 transcribe、activation、series 的 unit。
 */
import type { Page, Worker } from '@playwright/test';
import type { Message, PagesResponse } from '../src/shared/messages.ts';
import { hammingDistance, pageHash, SAME_PAGE_MAX_DISTANCE } from '../src/shared/page-hash.ts';
import { readGray } from '../src/testing/synthetic.ts';
import { activateOnJumpPlus, expect, testActivate, test } from './fixtures.ts';

/** 跟 pages.spec.ts 一樣用真的視窗：截圖與 rect 才對得上。 */
test.use({ viewport: null, fakeTranslator: true });

const translateCalls = (sw: Worker) => sw.evaluate(() => globalThis.__translateCalls ?? 0);

const statusLines = (panel: Page) => panel.getByRole('status', { name: '翻譯狀態' });

async function currentHashes(panel: Page, tabId: number): Promise<string[]> {
  const response = await panel.evaluate(
    (message) => chrome.runtime.sendMessage<Message, PagesResponse>(message),
    { type: 'panel:getPages', tabId } satisfies Message,
  );
  return response.pages.map((p) => p.pageHash);
}

test('翻譯 → 重新整理 → 再啟動：重新截圖仍認得同一頁，直接用快取', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await expect(statusLines(panel).filter({ hasText: /^已翻譯・/ })).toHaveCount(2);
  const callsAfterFirst = await translateCalls(sw);

  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await page.bringToFront();
  await testActivate(panel, tabId);

  await expect(statusLines(panel).filter({ hasText: /^快取・/ })).toHaveCount(2);
  await expect(panel.getByRole('list', { name: '逐字稿' }).first().getByText('早安！今天好早喔')).toBeVisible();
  expect(await translateCalls(sw)).toBe(callsAfterFirst);
});

test('截圖（顯示寬 430 px）算出的 hash 跟 Node 對原始合成頁算的在門檻內', async ({ context, sw, extensionId, mockSite }) => {
  const { panel, tabId } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await expect.poll(async () => (await currentHashes(panel, tabId)).length).toBe(2);
  const captured = await currentHashes(panel, tabId);
  const originals = ['p01-basic', 'p02-ruby'].map((id) => pageHash(readGray(id)));
  const same = captured.map((h, i) => hammingDistance(h, originals[i]!));
  const crossed = captured.map((h, i) => hammingDistance(h, originals[1 - i]!));
  console.log('截圖 vs 原圖：同頁', same, '異頁', crossed);
  for (const d of same) expect(d).toBeLessThanOrEqual(SAME_PAGE_MAX_DISTANCE);
  for (const d of crossed) expect(d).toBeGreaterThan(SAME_PAGE_MAX_DISTANCE);
});
