/**
 * #33：Page 身分與翻譯快取。用 FakeTranslator（SW 的 __translateCalls 記被呼叫幾次）。
 * 仿 Jump+ 啟動時第 1、2 頁完整可見，所以每次擷取是兩個 Page。
 */
import type { Page, Worker } from '@playwright/test';
import type { Message, PagesResponse } from '../src/shared/messages.ts';
import { hammingDistance, pageHash, SAME_PAGE_MAX_DISTANCE } from '../src/shared/page-hash.ts';
import type { PageTranslation } from '../src/shared/page-text.ts';
import type { Series } from '../src/shared/series.ts';
import { readGray } from '../src/testing/synthetic.ts';
import { activateOnJumpPlus, expect, testActivate, test } from './fixtures.ts';

/** 跟 pages.spec.ts 一樣用真的視窗：截圖與 rect 才對得上。 */
test.use({ viewport: null, fakeTranslator: true });

/** 第一次載入模型（從 mock site 下載＋wasm 編譯）加上兩頁 OCR。 */
const TRANSCRIPT_TIMEOUT = 60_000;

const translateCalls = (sw: Worker) => sw.evaluate(() => globalThis.__translateCalls ?? 0);

/** 在 SW 裡直接讀 IndexedDB（只讀，不經過外掛的程式）。 */
function readStore<T>(sw: Worker, store: string): Promise<T[]> {
  return sw.evaluate(
    (store) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('manga-translator');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result as T[]);
          request.onerror = () => reject(request.error);
        };
      }),
    store,
  );
}

const statusLines = (panel: Page) => panel.getByRole('status', { name: '翻譯狀態' });

async function currentHashes(panel: Page, tabId: number): Promise<string[]> {
  const response = await panel.evaluate(
    (message) => chrome.runtime.sendMessage<Message, PagesResponse>(message),
    { type: 'panel:getPages', tabId } satisfies Message,
  );
  return response.pages.map((p) => p.pageHash);
}

test('翻譯 → 重新整理 → 再啟動：直接用快取，FakeTranslator 沒有再被呼叫', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(TRANSCRIPT_TIMEOUT + 60_000);
  const { page, panel, tabId } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });

  await expect(statusLines(panel)).toHaveCount(2, { timeout: TRANSCRIPT_TIMEOUT });
  await expect(statusLines(panel).first()).toHaveText(/^已翻譯・fake・0\.0 秒・\$0\.0000$/);
  const callsAfterFirst = await translateCalls(sw);
  expect(callsAfterFirst).toBe(2);
  const firstHashes = await currentHashes(panel, tabId);

  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await page.bringToFront();
  await testActivate(panel, tabId);

  await expect(statusLines(panel).filter({ hasText: /^快取・/ })).toHaveCount(2, { timeout: 15_000 });
  await expect(statusLines(panel).first()).toHaveText('快取・fake・0.0 秒・$0.0000');
  await expect(panel.getByRole('list', { name: '逐字稿' }).first().getByText('早安！今天好早喔')).toBeVisible();
  expect(await translateCalls(sw)).toBe(callsAfterFirst);

  // 重新整理前後同一頁的 hash 距離（量測用，門檻是 SAME_PAGE_MAX_DISTANCE）
  const secondHashes = await currentHashes(panel, tabId);
  console.log('重新整理前後的 hash 距離', firstHashes.map((h, i) => hammingDistance(h, secondHashes[i]!)));
  console.log('第 1、2 頁之間的 hash 距離', hammingDistance(firstHashes[0]!, firstHashes[1]!));
  expect(firstHashes.map((h, i) => hammingDistance(h, secondHashes[i]!)).every((d) => d <= SAME_PAGE_MAX_DISTANCE)).toBe(true);
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

test('沒有網址模式時建立 Provisional Series，快取寫在它的 ID 下；停止後再啟動是新的一個', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(TRANSCRIPT_TIMEOUT + 60_000);
  const { page, panel, tabId } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await expect(statusLines(panel)).toHaveCount(2, { timeout: TRANSCRIPT_TIMEOUT });

  const series = await readStore<Series>(sw, 'series');
  expect(series).toHaveLength(1);
  const now = new Date();
  expect(series[0]).toMatchObject({ provisional: true, name: `未命名・127.0.0.1・${now.getMonth() + 1}/${now.getDate()}` });
  const cached = await readStore<PageTranslation>(sw, 'pageTranslations');
  expect(cached).toHaveLength(2);
  expect(cached.every((t) => t.seriesId === series[0]!.id)).toBe(true);
  expect(cached.map((t) => t.balloons.length)).not.toContain(0);

  // 停止後再啟動是新的一次啟動：新的 Provisional Series，舊的快取不算數，重新翻譯
  await panel.getByRole('button', { name: '停止' }).click();
  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  const callsBefore = await translateCalls(sw);
  await page.bringToFront();
  await testActivate(panel, tabId);
  await expect(statusLines(panel).filter({ hasText: /^已翻譯・/ })).toHaveCount(2, { timeout: TRANSCRIPT_TIMEOUT });
  expect(await translateCalls(sw)).toBe(callsBefore + 2);
  const after = await readStore<Series>(sw, 'series');
  expect(after).toHaveLength(2);
  const second = after.find((s) => s.id !== series[0]!.id)!;
  expect((await readStore<PageTranslation>(sw, 'pageTranslations')).filter((t) => t.seriesId === second.id)).toHaveLength(2);
});
