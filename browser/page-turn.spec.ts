/**
 * #34：翻頁偵測與自動翻譯。用仿 Jump+ 的翻頁版（一次一頁、RTL、450 ms 動畫）。
 * OCR 用 FakeEngine 重播（ADR 0007；@e2e 那條在 e2e 跑真模型），譯文來自 FakeTranslator（SW 的 __translateCalls 記被呼叫幾次、__jobLog 記佇列事件）。
 */
import type { Page, Worker } from '@playwright/test';
import type { Message, PagesResponse } from '../src/shared/messages.ts';
import { hammingDistance, SAME_PAGE_MAX_DISTANCE } from '../src/shared/page-hash.ts';
import { activateOnJumpPlus, expect, openPanelMenu, test } from './fixtures.ts';

test.use({ viewport: null, fakeTranslator: true });

const translateCalls = (sw: Worker) => sw.evaluate(() => globalThis.__translateCalls ?? 0);
const jobLog = (sw: Worker) => sw.evaluate(() => globalThis.__jobLog ?? []);
const captureCount = (sw: Worker) => sw.evaluate(() => globalThis.__captureLog?.length ?? 0);

const statusLines = (panel: Page) => panel.getByRole('status', { name: '翻譯狀態' });

/** 有覆蓋層譯文的 canvas 是第幾頁（0 起算）。 */
function overlaidPages(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.viewer canvas')];
    const pages = [...document.querySelectorAll('[data-naruhodo-overlay]')]
      .filter((host) => host.shadowRoot!.querySelector('[data-balloon-id]'))
      .map((host) => canvases.indexOf(host.previousElementSibling!));
    return [...new Set(pages)].sort((a, b) => a - b);
  });
}

const expectOverlaid = (page: Page, index: number, timeout?: number) =>
  expect.poll(async () => (await overlaidPages(page)).includes(index), { timeout }).toBe(true);

/** ← 鍵＝下一頁（RTL）。 */
async function nextPage(page: Page): Promise<void> {
  await page.keyboard.press('ArrowLeft');
}

async function visibleHashes(panel: Page, tabId: number): Promise<string[]> {
  const response = await panel.evaluate(
    (message) => chrome.runtime.sendMessage<Message, PagesResponse>(message),
    { type: 'panel:getPages', tabId } satisfies Message,
  );
  return response.pages.map((p) => p.pageHash);
}

const samePage = (a: string, b: string) => hammingDistance(a, b) <= SAME_PAGE_MAX_DISTANCE;

test('翻頁後新 Page 自動翻譯並覆蓋；翻回來命中快取', { tag: '@e2e' }, async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });

  await expectOverlaid(page, 0);
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/]);
  expect(await translateCalls(sw)).toBe(1);

  await nextPage(page);
  await expectOverlaid(page, 1);
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/]);
  expect(await translateCalls(sw)).toBe(2);

  await page.keyboard.press('ArrowRight');
  await expect(statusLines(panel)).toHaveText([/^快取・/]);
  expect(await translateCalls(sw)).toBe(2);
  await expectOverlaid(page, 0);

  // 自己的覆蓋層（插入 host、截圖前後隱藏）不算翻頁：停下來之後不會一直截圖
  // 翻頁後的那串擷取（動畫中的翻頁訊號、補截帶覆蓋層的樣子）要先跑完：最後一次截圖已經過了 1 秒。
  // 一直截圖停不下來的話，這裡就會逾時
  await expect.poll(() => sw.evaluate(() => Date.now() - (globalThis.__captureLog?.at(-1) ?? 0))).toBeGreaterThan(1_000);
  const settled = await captureCount(sw);
  await page.waitForTimeout(2_000);
  expect(await captureCount(sw)).toBeLessThanOrEqual(settled + 1);
});

test.describe('OCR 比翻頁慢', () => {
  // FakeEngine 幾乎不花時間，中間的頁會在被丟掉之前就做完；每頁 8 秒，比連翻三頁久
  // （5 秒時整批平行跑偶爾不夠：第 1 頁做完時最後那頁還沒排進來，就先做了中間的頁）
  const FAKE_OCR_DELAY_MS = 8_000;
  test.use({ fakeOcrDelayMs: FAKE_OCR_DELAY_MS });

  test('快速連翻多頁：最後停下的那頁先做，中間翻過去還沒開始的丟掉', async ({ context, sw, extensionId, mockSite }) => {
    // 故意讓 OCR 慢：要等第 1 頁和最後那頁兩次 FakeEngine 延遲，超過預設的 30 秒
    test.setTimeout(30_000 + 2 * FAKE_OCR_DELAY_MS);
    const { page, panel, tabId } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
    // 第 1 頁開始跑本機流水線（FakeEngine 每頁 5 秒）
    await expect.poll(async () => (await jobLog(sw)).some((e) => e.event === 'start')).toBe(true);

    // 每翻一頁就等它被擷取、排進佇列，中間的頁才會都排進去
    const enqueued = async () => (await jobLog(sw)).filter((e) => e.event === 'enqueue').length;
    for (let i = 0; i < 3; i++) {
      const before = await enqueued();
      await nextPage(page);
      await expect.poll(enqueued).toBeGreaterThan(before);
    }
    await expect(page.locator('body')).toHaveAttribute('data-page-index', '3');

    // 要等第 1 頁做完、再做最後那頁：兩頁的 FakeEngine 延遲
    await expectOverlaid(page, 3, 2 * FAKE_OCR_DELAY_MS + 5_000);
    const [finalHash] = await visibleHashes(panel, tabId);
    const log = await jobLog(sw);
    console.log(
      '佇列事件',
      log.map((e) => `${e.event}:${e.pageHash.slice(0, 6)}`),
    );
    const finalEnqueued = log.findIndex((e) => e.event === 'enqueue' && samePage(e.pageHash, finalHash!));
    expect(finalEnqueued).toBeGreaterThanOrEqual(0);
    // 最後那頁排進去之後，第一個開始的就是它
    const nextStart = log.slice(finalEnqueued).find((e) => e.event === 'start');
    expect(samePage(nextStart!.pageHash, finalHash!)).toBe(true);
    // 中間翻過去的頁（第 2、3 頁）在最後那頁做完之前都沒有做完
    const finalDone = log.findIndex((e) => e.event === 'done' && samePage(e.pageHash, finalHash!));
    const firstStarted = log.find((e) => e.event === 'start')!.pageHash;
    const middleDoneBefore = log
      .slice(0, finalDone)
      .filter((e) => e.event === 'done' && !samePage(e.pageHash, firstStarted) && !samePage(e.pageHash, finalHash!));
    expect(middleDoneBefore).toEqual([]);
  });
});

test('關掉自動翻譯後翻頁不會翻譯，按「翻譯此頁」才翻', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: mockSite.jumpPlusPagedUrl });
  await expectOverlaid(page, 0);

  const toggle = (await openPanelMenu(panel)).getByRole('switch', { name: '自動翻譯' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.bringToFront();
  await nextPage(page);

  await expect(panel.getByText('未翻譯（自動翻譯已關閉')).toBeVisible();
  // 斷言「自動翻譯關掉後沒有翻」：等一段時間確認翻譯次數沒變
  await page.waitForTimeout(1_500);
  expect(await translateCalls(sw)).toBe(1);
  expect(await overlaidPages(page)).toEqual([0]);

  await panel.getByRole('button', { name: '翻譯此頁' }).click();
  await page.bringToFront();
  await expectOverlaid(page, 1);
  expect(await translateCalls(sw)).toBe(2);
});
