/**
 * #39、#76 學習功能：side panel 逐字稿依 Page Mode 顯示（閱讀三種 Display Level；學習藏譯文＋振り仮名開關）、
 * 頁面 ↔ panel 的 hover 同步。
 * 偵測＋OCR 是真的（wasm），讀音與譯文來自 FakeTranslator（ground truth）。
 */
import type { Locator, Page } from '@playwright/test';
import { activateOnJumpPlus, expect, test } from './fixtures.ts';
import { overlayTexts, pageMode, shownTranslations } from './overlay-helpers.ts';

test.use({ viewport: null, fakeTranslator: true });

/** 第一次載入模型＋兩頁 OCR。 */
const TIMEOUT = 60_000;
/** p01 t1：おはよう！今日は早いね（おはよう！きょうははやいね） */
const GREETING_ZH = '早安！今天好早喔';

const firstTranscript = (panel: Page): Locator =>
  panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: '第 1 頁' }).getByRole('list', { name: '逐字稿' });

const level = (panel: Page, name: string) => panel.getByRole('group', { name: '顯示層級' }).getByRole('button', { name, exact: true });

/** 逐字稿一行裡的日文原文（不含徽章與譯文）。 */
const original = (line: Locator): Locator => line.locator('[lang="ja"]').first();
/** 逐字稿一行裡的中文譯文。 */
const translation = (line: Locator): Locator => line.locator('[lang="zh-Hant"]');

test('閱讀時切換三種顯示層級，逐字稿內容正確', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(TIMEOUT + 30_000);
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  const transcript = firstTranscript(panel);
  const greeting = transcript.getByRole('listitem').filter({ hasText: GREETING_ZH });
  await expect(greeting).toBeVisible({ timeout: TIMEOUT });

  // 只有三個層級（「只看日文」由學習取代）；上方不再有ルビ說明框
  await expect(panel.getByRole('group', { name: '顯示層級' }).getByRole('button')).toHaveText(['只看譯文', '原文＋譯文', '加振り仮名']);
  await expect(panel.getByText('ルビ為 LLM 推測')).toHaveCount(0);

  // 預設：加振り仮名（原文帶ルビ＋譯文），讀音是推測的那行標徽章
  await expect(level(panel, '加振り仮名')).toHaveAttribute('aria-pressed', 'true');
  await expect(original(greeting).locator('rt')).toHaveText(['きょう', 'はや']);
  await expect(original(greeting).locator('ruby').first()).toContainText('今日');
  await expect(greeting.getByText('讀音為推測', { exact: true })).toBeVisible();
  await expect(translation(greeting)).toHaveText(GREETING_ZH);
  // 字級：日文約 17px、中文約 15px
  await expect(original(greeting)).toHaveCSS('font-size', '17px');
  await expect(translation(greeting)).toHaveCSS('font-size', '15px');

  await level(panel, '原文＋譯文').click();
  await expect(level(panel, '原文＋譯文')).toHaveAttribute('aria-pressed', 'true');
  await expect(level(panel, '加振り仮名')).toHaveAttribute('aria-pressed', 'false');
  await expect(transcript.locator('rt')).toHaveCount(0);
  await expect(transcript.getByText('讀音為推測')).toHaveCount(0);
  await expect(original(greeting)).toContainText('今日は早いね');
  await expect(translation(greeting)).toHaveText(GREETING_ZH);

  await level(panel, '只看譯文').click();
  await expect(transcript.locator('[lang="ja"]')).toHaveCount(0);
  await expect(translation(greeting)).toHaveText(GREETING_ZH);

  // 整頁一起切：第 2 頁也是
  const second = panel.getByRole('list', { name: '逐字稿' }).nth(1);
  await expect(second.getByRole('listitem').first()).toBeVisible({ timeout: TIMEOUT });
  await expect(second.locator('[lang="ja"]')).toHaveCount(0);
  await level(panel, '加振り仮名').click();
  await expect(second.locator('rt').first()).toBeVisible();
});

test('學習時逐字稿藏譯文，滑過「譯」區塊才出現；振り仮名 Switch 開關ルビ', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(TIMEOUT + 30_000);
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  const transcript = firstTranscript(panel);
  await expect(transcript.getByRole('listitem').filter({ hasText: GREETING_ZH })).toBeVisible({ timeout: TIMEOUT });
  // 學習時譯文藏起來沒得篩，先記下第幾行
  const index = (await transcript.getByRole('listitem').allInnerTexts()).findIndex((t) => t.includes(GREETING_ZH));
  const greeting = transcript.getByRole('listitem').nth(index);

  await pageMode(panel, '學習').click();
  // 沒有 Display Level 切換，改成振り仮名 Switch（預設開）
  await expect(panel.getByRole('group', { name: '顯示層級' })).toHaveCount(0);
  const furigana = panel.getByRole('switch', { name: '逐字稿加振り仮名' });
  await expect(furigana).toBeChecked();
  await expect(original(greeting).locator('rt')).toHaveText(['きょう', 'はや']);
  await expect(greeting.getByText('讀音為推測', { exact: true })).toBeVisible();
  // 譯文藏在「譯」區塊後面
  await expect(transcript).not.toContainText(GREETING_ZH);
  const reveal = greeting.getByRole('group', { name: '譯' });
  await expect(reveal).toContainText('滑過這裡看譯文');

  // 背景分頁的 rAF 會停，Playwright 的 hover 要等穩定；panel 放到前景
  await panel.bringToFront();
  await reveal.hover();
  await expect(reveal).toContainText(GREETING_ZH);
  await panel.mouse.move(1, 1);
  await expect(transcript).not.toContainText(GREETING_ZH);
  await expect(reveal).toContainText('滑過這裡看譯文');

  // 關掉振り仮名：ルビ與推測徽章都不見，原文還在、譯文仍藏著
  await furigana.click();
  await expect(furigana).not.toBeChecked();
  await expect(transcript.locator('rt')).toHaveCount(0);
  await expect(transcript.getByText('讀音為推測')).toHaveCount(0);
  await expect(original(greeting)).toContainText('今日は早いね');
  await expect(transcript).not.toContainText(GREETING_ZH);
  await furigana.click();
  await expect(original(greeting).locator('rt')).toHaveText(['きょう', 'はや']);

  // 切回閱讀：Display Level 回來，譯文直接顯示
  await pageMode(panel, '閱讀').click();
  await expect(level(panel, '加振り仮名')).toHaveAttribute('aria-pressed', 'true');
  await expect(translation(greeting)).toHaveText(GREETING_ZH);
});

/** 頁面上 p01 問候句的譯文元素（畫面座標的中心）。 */
async function greetingOnPage(page: Page): Promise<{ x: number; y: number }> {
  let center: { x: number; y: number } | undefined;
  await expect
    .poll(
      async () => {
        const text = (await overlayTexts(page)).find((t) => t.text.replace(/\s/g, '') === GREETING_ZH);
        center = text && { x: text.rect.x + text.rect.width / 2, y: text.rect.y + text.rect.height / 2 };
        return center !== undefined;
      },
      { timeout: TIMEOUT },
    )
    .toBe(true);
  return center!;
}

test('滑過頁面 Balloon：頁面出 tooltip、panel 對應行高亮；滑過 panel 那行：頁面 Balloon 高亮；覆蓋層不擋點擊', async ({
  context,
  sw,
  extensionId,
  mockSite,
}) => {
  test.setTimeout(TIMEOUT + 30_000);
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  const center = await greetingOnPage(page);
  const line = firstTranscript(panel).getByRole('listitem').filter({ hasText: GREETING_ZH });
  await expect(line).toBeVisible();
  const tooltip = page.locator('[data-naruhodo-overlay] .tip.on');

  // 頁面 → panel
  await page.mouse.move(1, 1);
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(center.x, center.y);
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toContainText(GREETING_ZH);
  await expect(tooltip).toContainText('讀音為推測');
  await expect(tooltip.locator('rt')).toHaveText(['きょう', 'はや']);
  await expect(line).toHaveClass(/\bhl\b/);
  await expect(panel.locator('[aria-label="逐字稿"] li.hl')).toHaveCount(1);
  await page.mouse.move(1, 1);
  await expect(tooltip).toHaveCount(0);
  await expect(line).not.toHaveClass(/\bhl\b/);

  // panel → 頁面：高亮框蓋住那個 Balloon
  const highlight = page.locator('[data-naruhodo-overlay] .hl.on');
  await expect(highlight).toHaveCount(0);
  // 背景分頁的 rAF 會停，Playwright 的 hover 要等穩定；panel 放到前景（真的 side panel 跟頁面同時可見）
  await panel.bringToFront();
  await line.hover();
  await expect(highlight).toHaveCount(1);
  const box = (await highlight.boundingBox())!;
  expect(center.x).toBeGreaterThan(box.x);
  expect(center.x).toBeLessThan(box.x + box.width);
  expect(center.y).toBeGreaterThan(box.y);
  expect(center.y).toBeLessThan(box.y + box.height);
  await panel.mouse.move(1, 1);
  await expect(highlight).toHaveCount(0);
  await page.bringToFront();

  // 覆蓋層 pointer-events:none：點在譯文上，點擊落到主頁面的 canvas（Jump+ 靠它翻頁）
  await page.evaluate(() => {
    const g = globalThis as unknown as { __clicked: number[] };
    g.__clicked = [];
    const canvases = [...document.querySelectorAll('.viewer canvas')];
    document.addEventListener('click', (e) => g.__clicked.push(canvases.indexOf(e.target as Element)));
  });
  await page.mouse.click(center.x, center.y);
  expect(await page.evaluate(() => (globalThis as unknown as { __clicked: number[] }).__clicked)).toEqual([0]);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, center)).toBe('CANVAS');
});

test('Page Mode 學習：頁面保留日文；滑過 Balloon 的 tooltip 有原文與振り仮名、沒有譯文；hover 雙向同步；不擋點擊', async ({
  context,
  sw,
  extensionId,
  mockSite,
}) => {
  test.setTimeout(TIMEOUT + 30_000);
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  // 譯文元素藏起來後 rect 不變（visibility），還是拿它當 Balloon 的位置
  const center = await greetingOnPage(page);
  // 學習時逐字稿也藏譯文，切換前先記下第幾行
  const transcript = firstTranscript(panel);
  await expect(transcript.getByRole('listitem').filter({ hasText: GREETING_ZH })).toBeVisible();
  const index = (await transcript.getByRole('listitem').allInnerTexts()).findIndex((t) => t.includes(GREETING_ZH));
  const line = transcript.getByRole('listitem').nth(index);
  await pageMode(panel, '學習').click();
  await expect(shownTranslations(page)).toHaveCount(0);
  await page.bringToFront();
  const tooltip = page.locator('[data-naruhodo-overlay] .tip.on');

  // 頁面 → panel
  await page.mouse.move(1, 1);
  await page.mouse.move(center.x, center.y);
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip.locator('rt')).toHaveText(['きょう', 'はや']);
  await expect(tooltip).toContainText('今日');
  await expect(tooltip).toContainText('讀音為推測');
  await expect(tooltip).not.toContainText(GREETING_ZH);
  await expect(line).toHaveClass(/\bhl\b/);
  await page.mouse.move(1, 1);
  await expect(tooltip).toHaveCount(0);

  // panel → 頁面
  const highlight = page.locator('[data-naruhodo-overlay] .hl.on');
  await panel.bringToFront();
  await line.hover();
  await expect(highlight).toHaveCount(1);
  await panel.mouse.move(1, 1);
  await expect(highlight).toHaveCount(0);
  await page.bringToFront();

  // 點擊落到主頁面的 canvas
  await page.evaluate(() => {
    const g = globalThis as unknown as { __clicked: number[] };
    g.__clicked = [];
    const canvases = [...document.querySelectorAll('.viewer canvas')];
    document.addEventListener('click', (e) => g.__clicked.push(canvases.indexOf(e.target as Element)));
  });
  await page.mouse.click(center.x, center.y);
  expect(await page.evaluate(() => (globalThis as unknown as { __clicked: number[] }).__clicked)).toEqual([0]);
});
