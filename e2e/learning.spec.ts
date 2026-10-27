/**
 * #39 學習模式：side panel 的全域顯示層級、振り仮名、頁面 ↔ panel 的 hover 同步。
 * 偵測＋OCR 是真的（wasm），讀音與譯文來自 FakeTranslator（ground truth）。
 */
import type { Locator, Page } from '@playwright/test';
import { activateOnJumpPlus, expect, test } from './fixtures.ts';
import { overlayTexts } from './overlay-helpers.ts';

test.use({ viewport: null, fakeTranslator: true });

/** 第一次載入模型＋兩頁 OCR。 */
const TIMEOUT = 60_000;
/** p01 t1：おはよう！今日は早いね（おはよう！きょうははやいね） */
const GREETING_ZH = '早安！今天好早喔';

const firstTranscript = (panel: Page): Locator =>
  panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: '第 1 頁' }).getByRole('list', { name: '逐字稿' });

const level = (panel: Page, name: string) => panel.getByRole('group', { name: '顯示層級' }).getByRole('button', { name, exact: true });

test('切換四種顯示層級時逐字稿內容正確', async ({ context, sw, extensionId, mockSite }) => {
  test.setTimeout(TIMEOUT + 30_000);
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  const transcript = firstTranscript(panel);
  await expect(transcript.getByRole('listitem').filter({ hasText: GREETING_ZH })).toBeVisible({ timeout: TIMEOUT });
  // 只看日文時沒有譯文可以篩，先記下第幾行
  const index = (await transcript.getByRole('listitem').allInnerTexts()).findIndex((t) => t.includes(GREETING_ZH));
  const greeting = transcript.getByRole('listitem').nth(index);
  const legend = panel.getByText('ルビ為 LLM 推測，義訓可能讀錯');
  const original = greeting.locator('.original');
  const translation = greeting.locator('.translation');

  // 預設：加振り仮名（原文帶ルビ＋譯文），上方標示讀音是推測
  await expect(level(panel, '加振り仮名')).toHaveAttribute('aria-pressed', 'true');
  await expect(legend).toBeVisible();
  await expect(original.locator('rt')).toHaveText(['きょう', 'はや']);
  await expect(original.locator('ruby').first()).toContainText('今日');
  await expect(translation).toHaveText(GREETING_ZH);

  await level(panel, '原文＋譯文').click();
  await expect(level(panel, '原文＋譯文')).toHaveAttribute('aria-pressed', 'true');
  await expect(level(panel, '加振り仮名')).toHaveAttribute('aria-pressed', 'false');
  await expect(legend).toBeHidden();
  await expect(transcript.locator('rt')).toHaveCount(0);
  await expect(original).toContainText('今日は早いね');
  await expect(translation).toHaveText(GREETING_ZH);

  await level(panel, '只看譯文').click();
  await expect(transcript.locator('.original, .loose')).toHaveCount(0);
  await expect(translation).toHaveText(GREETING_ZH);

  await level(panel, '只看日文').click();
  await expect(transcript.locator('.translation')).toHaveCount(0);
  await expect(transcript.locator('rt')).toHaveCount(0);
  await expect(original).toContainText('今日は早いね');
  await expect(legend).toBeHidden();

  // 整頁一起切：第 2 頁也是
  const second = panel.getByRole('list', { name: '逐字稿' }).nth(1);
  await expect(second.getByRole('listitem').first()).toBeVisible({ timeout: TIMEOUT });
  await expect(second.locator('.translation')).toHaveCount(0);
  await level(panel, '加振り仮名').click();
  await expect(second.locator('rt').first()).toBeVisible();
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
