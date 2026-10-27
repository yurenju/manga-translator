/**
 * 第 2 層（spec #27 第 12 節）：覆蓋渲染。在 e2e build 的外掛測試頁把合成頁的 ground truth 直接畫成覆蓋層
 * （不跑 OCR），量每個譯文元素的 rect、斷言落在對應的 Balloon 內，並存截圖。
 * 顯示寬度跟仿 Jump+ 一樣是 430（倍率約 0.49），最小畫面字級 9px 才有作用。
 */
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { PageMode } from '../src/shared/page-mode.ts';
import type { PageText, RatioRect } from '../src/shared/page-text.ts';
import { groundTruthPageTexts, readGroundTruth, SYNTHETIC_IDS } from '../src/testing/synthetic.ts';
import { expect, test } from './fixtures.ts';
import { overlayTexts, type ScreenRect } from './overlay-helpers.ts';

const SYNTHETIC = new URL('../testdata/synthetic/out/', import.meta.url);

/** 跟仿 Jump+ 一樣的單頁顯示寬度；Spread 兩倍。 */
const PAGE_WIDTH = 430;

declare global {
  var __renderOverlay: (input: { image: string; width: number; pages: { sub: RatioRect; text: PageText }[]; pageMode?: PageMode }) => Promise<void>;
}

async function render(page: Page, id: string, width: number, pages = groundTruthPageTexts(id), pageMode?: PageMode): Promise<void> {
  const image = `data:image/png;base64,${(await readFile(new URL(`${id}.png`, SYNTHETIC))).toString('base64')}`;
  await page.evaluate((input) => globalThis.__renderOverlay(input), { image, width, pages, pageMode });
}

const anchorRect = (page: Page): Promise<ScreenRect> =>
  page.locator('img').evaluate((img) => {
    const r = img.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

test.describe('覆蓋渲染（ground truth）', () => {
  test.use({ viewport: { width: 1000, height: 1400 } });

  for (const id of SYNTHETIC_IDS) {
    test(`${id}：每個譯文元素都落在對應的 Balloon 內，字級不小於畫面 9px`, async ({ context, extensionId }, testInfo) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
      const gt = readGroundTruth(id);
      const width = (PAGE_WIDTH * gt.width) / 880;
      await render(page, id, width);

      const anchor = await anchorRect(page);
      const scale = anchor.width / gt.width;
      const texts = await overlayTexts(page);
      const expected = groundTruthPageTexts(id).flatMap((p) => p.text.balloons.map((b) => b.id));
      expect(texts.map((t) => t.id).sort()).toEqual([...expected].sort());
      for (const text of texts) {
        const [x, y, w, h] = gt.texts.find((t) => t.id === text.id)!.bbox;
        const balloon = { x: anchor.x + x * scale, y: anchor.y + y * scale, width: w * scale, height: h * scale };
        expect.soft(text.rect.x, `${text.id} 左`).toBeGreaterThanOrEqual(balloon.x - 0.5);
        expect.soft(text.rect.y, `${text.id} 上`).toBeGreaterThanOrEqual(balloon.y - 0.5);
        expect.soft(text.rect.x + text.rect.width, `${text.id} 右`).toBeLessThanOrEqual(balloon.x + balloon.width + 0.5);
        expect.soft(text.rect.y + text.rect.height, `${text.id} 下`).toBeLessThanOrEqual(balloon.y + balloon.height + 0.5);
        expect.soft(text.screenFontPx, `${text.id} 畫面字級`).toBeGreaterThanOrEqual(9 - 0.01);
      }
      console.log(`${id}`, texts.map((t) => `${t.id} 第${t.fit}階 ${t.screenFontPx.toFixed(1)}px`).join(' / '));
      const shot = testInfo.outputPath(`${id}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      await testInfo.attach(id, { path: shot, contentType: 'image/png' });
    });
  }

  test('p05 的「～」直書時是直的', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    // 原尺寸顯示，字形才夠大到能量
    await render(page, 'p05-dense', 880);

    const clip = await page.evaluate(() => {
      const host = document.querySelector('[data-naruhodo-overlay]')!;
      const tx = host.shadowRoot!.querySelector('[data-balloon-id="t4"]')!;
      const walker = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.textContent!.indexOf('～');
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        return { vertical: getComputedStyle(tx).writingMode, x: r.x, y: r.y, width: r.width, height: r.height };
      }
      throw new Error('no ～');
    });
    expect(clip.vertical).toBe('vertical-rl');
    // 直書時字框的寬是行高，左右會碰到隔壁欄；只量中間的 em 正方形（邊長＝字框高）
    const em = { x: clip.x + (clip.width - clip.height) / 2, y: clip.y, width: clip.height, height: clip.height };
    const png = await page.screenshot({ clip: em });
    const ink = await page.evaluate(async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let [left, top, right, bottom] = [width, height, -1, -1];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i]! + data[i + 1]! + data[i + 2]! < 3 * 128) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return { width: right - left + 1, height: bottom - top + 1 };
    }, `data:image/png;base64,${png.toString('base64')}`);
    console.log('～ 的字形墨跡', JSON.stringify(ink), '字框', JSON.stringify(clip));
    // 橫書的 ～ 是扁的；直書字形是直的
    expect(ink.height).toBeGreaterThan(ink.width * 1.5);
  });

  test('譯文太長時截斷，字級仍不小於畫面 9px，滑過時 tooltip 顯示原文＋ルビ＋譯文全文', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    const pages = groundTruthPageTexts('p01-basic').map(({ sub, text }) => ({
      sub,
      text: { ...text, balloons: text.balloons.map((b) => ({ ...b, 譯文: b.譯文.repeat(8) })) },
    }));
    await render(page, 'p01-basic', PAGE_WIDTH, pages);

    const texts = await overlayTexts(page);
    console.log('譯文 ×8', texts.map((t) => `${t.id} 第${t.fit}階 ${t.screenFontPx.toFixed(1)}px`).join(' / '));
    for (const text of texts) expect(text.screenFontPx).toBeGreaterThanOrEqual(9 - 0.01);
    const truncated = texts.find((t) => t.fit === 3);
    expect(truncated).toBeDefined();
    const balloon = pages[0]!.text.balloons.find((b) => b.id === truncated!.id)!;

    const tooltip = page.locator('[data-naruhodo-overlay] .tip');
    await expect(tooltip).toBeHidden();
    await page.mouse.move(truncated!.rect.x + truncated!.rect.width / 2, truncated!.rect.y + truncated!.rect.height / 2);
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator('.tip-zh')).toHaveText(balloon.譯文);
    // 原文去掉ルビ後就是 ground truth 原文
    expect(await tooltip.locator('.tip-ja').evaluate((el) => {
      const copy = el.cloneNode(true) as Element;
      copy.querySelectorAll('rt, .tip-guess').forEach((rt) => rt.remove());
      return copy.textContent;
    })).toBe(balloon.原文);
    await expect(tooltip).toContainText('讀音為推測');
    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();
  });

  test('學習時 Loose Text 的 tooltip 也有「譯」區塊、滑進才揭露；unreadable 的句子沒有「譯」區塊', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    // p04：t1「遅刻だー!!」當成 unreadable；t2「ドドドド」是狀聲詞（Loose Text）
    const pages = groundTruthPageTexts('p04-outside').map(({ sub, text }) => ({
      sub,
      text: { ...text, balloons: text.balloons.map((b) => (b.id === 't1' ? { ...b, unreadable: true } : b)) },
    }));
    const sfx = pages[0]!.text.looseText.find((l) => l.id === 't2')!;
    expect(sfx.譯文).not.toBe('');
    await render(page, 'p04-outside', PAGE_WIDTH, pages, 'learn');
    const anchor = await anchorRect(page);
    const centerOf = (r: RatioRect) => ({ x: anchor.x + (r.x + r.w / 2) * anchor.width, y: anchor.y + (r.y + r.h / 2) * anchor.height });
    const tooltip = page.locator('[data-naruhodo-overlay] .tip.on');

    const sfxCenter = centerOf(sfx.bbox);
    await page.mouse.move(sfxCenter.x, sfxCenter.y);
    await expect(tooltip).toContainText(sfx.原文);
    await expect(tooltip).not.toContainText(sfx.譯文);
    const chipBox = (await tooltip.getByText('滑過這裡看譯文').boundingBox())!;
    await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2, { steps: 10 });
    await expect(tooltip).toContainText(sfx.譯文);
    await page.mouse.move(1, 1);
    await expect(tooltip).toHaveCount(0);

    const unreadable = pages[0]!.text.balloons.find((b) => b.id === 't1')!;
    const unreadableCenter = centerOf(unreadable.balloonBbox);
    await page.mouse.move(unreadableCenter.x, unreadableCenter.y);
    await expect(tooltip).toContainText('無法辨識');
    await expect(tooltip.getByText('譯', { exact: true })).toHaveCount(0);
    await expect(tooltip).not.toContainText('滑過這裡看譯文');
  });
});
