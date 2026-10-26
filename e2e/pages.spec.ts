import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { activateOnJumpPlus, expect, test } from './fixtures.ts';

/**
 * 用真的視窗（1280×1500）而不是 Playwright 模擬的 viewport：啟動時 side panel 會真的打開、把頁面擠窄，
 * 模擬的 viewport 不會跟著變，量到的 rect 就跟 captureVisibleTab 的截圖對不上（真實 Chrome 沒有這個問題）。
 * 可視高度約 1390 px；仿 Jump+ 每頁顯示 430×625、間隔 16 px，header 下方第 1、2 頁完整可見，第 3 頁只露出上半部。
 */
test.use({ viewport: null });

const SYNTHETIC = new URL('../testdata/synthetic/out/', import.meta.url);

/** 仿 Jump+ 前三頁；第 3 頁永遠只露出一部分，用來確認縮圖不會誤認成它。 */
const FIRST_PAGES = ['p01-basic', 'p02-ruby', 'p03-shapes'];

/**
 * 縮圖跟原合成頁的 dHash 距離在這以內算「內容一致」（256 bits）。
 * 實測同一頁約 21–22（大片白底的相鄰區塊亮度幾乎一樣，縮放雜訊就會翻轉），不同頁 100 以上。
 */
const SAME_PAGE_MAX_DISTANCE = 40;

async function syntheticDataUrl(id: string): Promise<string> {
  return `data:image/png;base64,${(await readFile(new URL(`${id}.png`, SYNTHETIC))).toString('base64')}`;
}

async function thumbnails(panel: Page): Promise<string[]> {
  return panel.getByRole('list', { name: 'Page' }).getByRole('img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
}

/** 在瀏覽器裡算 16×16 dHash 的 Hamming 距離。 */
async function hashDistance(panel: Page, a: string, b: string): Promise<number> {
  return panel.evaluate(
    async ([a, b]) => {
      const W = 17;
      const H = 16;
      // 一步縮到 17×16 會只取樣到零星像素（細線條忽有忽無），所以先縮到 B 倍大，再自己做區塊平均。
      const B = 8;
      async function dHash(src: string): Promise<boolean[]> {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = new OffscreenCanvas(W * B, H * B);
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, W * B, H * B);
        const { data } = ctx.getImageData(0, 0, W * B, H * B);
        const gray = (x: number, y: number) => {
          let sum = 0;
          for (let dy = 0; dy < B; dy++) {
            for (let dx = 0; dx < B; dx++) {
              const i = ((y * B + dy) * W * B + x * B + dx) * 4;
              sum += data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114;
            }
          }
          return sum / (B * B);
        };
        const bits: boolean[] = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) bits.push(gray(x, y) < gray(x + 1, y));
        return bits;
      }
      const [ha, hb] = await Promise.all([dHash(a), dHash(b)]);
      return ha.filter((bit, i) => bit !== hb[i]).length;
    },
    [a, b] as const,
  );
}

/** 每張縮圖都跟預期的合成頁最接近，而且距離在門檻內。 */
async function expectThumbnailsMatch(panel: Page, ids: string[]): Promise<void> {
  await expect.poll(async () => (await thumbnails(panel)).length).toBe(ids.length);
  const thumbs = await thumbnails(panel);
  const originals = await Promise.all(FIRST_PAGES.map(syntheticDataUrl));
  for (const [i, thumb] of thumbs.entries()) {
    const distances = await Promise.all(originals.map((o) => hashDistance(panel, thumb, o)));
    const expected = FIRST_PAGES.indexOf(ids[i]!);
    expect(distances[expected], `縮圖 ${i} 與 ${ids[i]} 的距離（全部：${distances}）`).toBeLessThanOrEqual(
      SAME_PAGE_MAX_DISTANCE,
    );
    expect(Math.min(...distances)).toBe(distances[expected]);
  }
}

test('啟動後 side panel 列出完整可見的 Page 縮圖，只露出一部分的不列', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });

  await expectThumbnailsMatch(panel, ['p01-basic', 'p02-ruby']);
});

test('捲動後重新擷取：上下都只露出一部分時只列中間那頁', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await expectThumbnailsMatch(panel, ['p01-basic', 'p02-ruby']);

  await page.evaluate(() => window.scrollTo(0, 300));
  await panel.getByRole('button', { name: '重新擷取' }).click();

  await expectThumbnailsMatch(panel, ['p02-ruby']);
});

test('連續觸發時截圖不超過 2 次/秒', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await expectThumbnailsMatch(panel, ['p01-basic', 'p02-ruby']);

  // 同一個 tab 還沒開始的掃描會合併，連按 5 次截幾次不一定；所以每次截圖一送出就馬上再按，
  // 下一次掃描排在這次後面、不限速的話會緊接著截。翻頁偵測（#34）也會觸發截圖，所以用相對次數。
  const captureCount = () => sw.evaluate(() => globalThis.__captureLog?.length ?? 0);
  const button = panel.getByRole('button', { name: '重新擷取' });
  for (let i = 0; i < 5; i++) {
    const before = await captureCount();
    await button.click();
    await expect.poll(captureCount, { intervals: [20] }).toBeGreaterThan(before);
  }

  const log = await sw.evaluate(() => globalThis.__captureLog!);
  for (let i = 1; i < log.length; i++) expect(log[i]! - log[i - 1]!).toBeGreaterThanOrEqual(500);
});

test.describe('DPR 1.5', () => {
  test.use({ realDeviceScaleFactor: 1.5 });

  test('裁切位置仍正確', async ({ context, sw, extensionId, mockSite }) => {
    const { page, panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });

    expect(await page.evaluate(() => devicePixelRatio)).toBe(1.5);
    await expectThumbnailsMatch(panel, ['p01-basic', 'p02-ruby']);
  });
});
