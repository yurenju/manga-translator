/**
 * #36：Series 選擇與歸類。網址模式＝origin＋path；選定非 Provisional 的 Series 後才記住。
 * 「停止」後再啟動才是新的一次啟動（已啟動的 tab 重新整理會沿用同一個 Series），所以每次都先停止再重新整理。
 */
import type { Page, Worker } from '@playwright/test';
import type { Message, SeriesResponse } from '../src/shared/messages.ts';
import type { PageTranslation } from '../src/shared/page-text.ts';
import type { Series } from '../src/shared/series.ts';
import { activateOnJumpPlus, expect, readStore, testActivate, test } from './fixtures.ts';

/** 跟 cache.spec.ts 一樣用真的視窗：截圖與 rect 才對得上。 */
test.use({ viewport: null });

/** 第一次載入模型（從 mock site 下載＋wasm 編譯）加上兩頁 OCR。 */
const TRANSCRIPT_TIMEOUT = 60_000;

const footer = (panel: Page) => panel.getByRole('contentinfo', { name: '狀態列' });
/** 底部那一行「系列＋名稱＋鉛筆」；平常只顯示名稱。 */
const seriesRow = (panel: Page) => footer(panel).getByRole('group', { name: '系列' });
/** 點鉛筆展開編輯區（改名、切換、新增、合併都在裡面）。 */
const openSeriesEditor = (panel: Page) => footer(panel).getByRole('button', { name: '改系列名稱' }).click();
const seriesSelect = (panel: Page) => footer(panel).getByRole('combobox', { name: 'Series', exact: true });

async function createSeries(panel: Page, name: string): Promise<void> {
  await openSeriesEditor(panel);
  await seriesSelect(panel).selectOption({ label: '新增 Series…' });
  await panel.getByRole('textbox', { name: 'Series 名稱' }).fill(name);
  await panel.getByRole('button', { name: '建立' }).click();
  await expect(seriesRow(panel)).toContainText(name);
}

/** 停止 → 重新整理 → 再啟動（新的一次啟動，要靠網址模式預選）。 */
async function stopReloadActivate(page: Page, panel: Page, tabId: number): Promise<void> {
  await panel.getByRole('button', { name: '停止' }).click();
  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await page.bringToFront();
  await testActivate(panel, tabId);
  await expect(panel.getByText('已啟動')).toBeVisible();
}

/** 這個 tab 目前的 Series ID（問 SW）。 */
const currentSeries = async (panel: Page, tabId: number) =>
  (await panel.evaluate((m) => chrome.runtime.sendMessage<Message, SeriesResponse>(m), { type: 'panel:getSeries', tabId } satisfies Message)).current;

const seriesNamed = async (sw: Worker, name: string) => (await readStore<Series>(sw, 'series')).find((s) => s.name === name);

test('選 Series 後重新整理再啟動，自動預選同一部 Series', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await expect(seriesRow(panel)).toContainText(/未歸類（未命名・127\.0\.0\.1・/);

  await createSeries(panel, '火ノ丸相撲');
  await stopReloadActivate(page, panel, tabId);

  await expect(seriesRow(panel)).toContainText('火ノ丸相撲');
  // 預選到的不會再建 Provisional Series：只有第一次啟動那一個＋火ノ丸相撲
  expect(await readStore<Series>(sw, 'series')).toHaveLength(2);
});

test('同網站的另一個網址不會被預選，建立 Provisional Series', async ({ context, sw, extensionId, mockSite }) => {
  const first = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await createSeries(first.panel, '火ノ丸相撲');

  const other = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: new URL('episode-2/', mockSite.jumpPlusUrl).href });

  await expect(seriesRow(other.panel)).toContainText(/未歸類（/);
  // 「火ノ丸相撲」仍在選單裡，而且是最近用過的，排在最上面
  await openSeriesEditor(other.panel);
  await expect(seriesSelect(other.panel).locator('option').first()).toHaveText('火ノ丸相撲');
});

test.describe('歸類（FakeTranslator）', () => {
  test.use({ fakeTranslator: true });

  test('Provisional Series 改名後 ID 不變、快取仍命中', async ({ context, sw, extensionId, mockSite }) => {
    test.setTimeout(TRANSCRIPT_TIMEOUT + 60_000);
    const { page, panel, tabId } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
    const statusLines = panel.getByRole('status', { name: '翻譯狀態' });
    await expect(statusLines.filter({ hasText: /^已翻譯・/ })).toHaveCount(2, { timeout: TRANSCRIPT_TIMEOUT });
    const [provisional] = await readStore<Series>(sw, 'series');
    const calls = await sw.evaluate(() => globalThis.__translateCalls ?? 0);

    // 平常只是文字；點鉛筆才出現輸入框
    await expect(footer(panel).getByRole('textbox')).toHaveCount(0);
    await openSeriesEditor(panel);
    await panel.getByRole('textbox', { name: '新名稱' }).fill('火ノ丸相撲');
    await panel.getByRole('button', { name: '儲存' }).click();
    await expect(seriesRow(panel)).toContainText('火ノ丸相撲');
    expect(await seriesNamed(sw, '火ノ丸相撲')).toEqual({ ...provisional, name: '火ノ丸相撲', provisional: false });

    await stopReloadActivate(page, panel, tabId);

    await expect(seriesRow(panel)).toContainText('火ノ丸相撲');
    await expect(statusLines.filter({ hasText: /^快取・/ })).toHaveCount(2, { timeout: 15_000 });
    expect(await sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(calls);
  });

  test('Provisional Series 合併進既有 Series：快取改用目標 ID、刪掉臨時 Series、不重翻', async ({ context, sw, extensionId, mockSite }) => {
    test.setTimeout(TRANSCRIPT_TIMEOUT + 60_000);
    const first = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
    const statusLines = first.panel.getByRole('status', { name: '翻譯狀態' });
    await expect(statusLines.filter({ hasText: /^已翻譯・/ })).toHaveCount(2, { timeout: TRANSCRIPT_TIMEOUT });
    // side panel 在 e2e 是另一個分頁：把仿 Jump+ 切回前景，重新擷取才截得到它
    await first.page.bringToFront();
    await createSeries(first.panel, '火ノ丸相撲');
    const target = (await seriesNamed(sw, '火ノ丸相撲'))!;
    // 選了新的 Series 會重新擷取、用新 ID 翻譯：等它寫完，目標就有這兩頁的快取
    await expect.poll(async () => (await readStore<PageTranslation>(sw, 'pageTranslations')).filter((t) => t.seriesId === target.id).length, { timeout: 15_000 }).toBe(2);

    const other = await activateOnJumpPlus({ context, sw, extensionId, mockSite, url: new URL('episode-2/', mockSite.jumpPlusUrl).href });
    await expect(other.panel.getByRole('status', { name: '翻譯狀態' }).filter({ hasText: /^已翻譯・/ })).toHaveCount(2, { timeout: TRANSCRIPT_TIMEOUT });
    const provisionalId = (await currentSeries(other.panel, other.tabId))!;
    expect((await readStore<PageTranslation>(sw, 'pageTranslations')).filter((t) => t.seriesId === provisionalId)).toHaveLength(2);
    const calls = await sw.evaluate(() => globalThis.__translateCalls ?? 0);

    await openSeriesEditor(other.panel);
    await other.panel.getByRole('combobox', { name: '合併進' }).selectOption({ label: '火ノ丸相撲' });
    await other.panel.getByRole('button', { name: '合併' }).click();

    await expect(seriesRow(other.panel)).toContainText('火ノ丸相撲');
    await expect.poll(async () => (await readStore<Series>(sw, 'series')).some((s) => s.id === provisionalId)).toBe(false);
    const cached = await readStore<PageTranslation>(sw, 'pageTranslations');
    expect(cached.filter((t) => t.seriesId === provisionalId)).toEqual([]);
    // 同一個仿 Jump+：hash 相同，保留目標原本的兩頁
    expect(cached.filter((t) => t.seriesId === target.id)).toHaveLength(2);
    expect(await sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(calls);
  });
});
