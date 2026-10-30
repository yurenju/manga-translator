/**
 * #109：產品網站首頁的互動展示。對 `npm run site:build` 產生的 site/dist 開一個靜態 server，用一般的瀏覽器（不載入外掛）操作。
 * unit 抓不到的：Astro／Vite 打包外掛元件的整條路（.css 變字串、字型檔、合成頁圖片）、SidePanel 在 shadow root 裡真的
 * render、覆蓋層在真正的版面上 hover 出 tooltip 並跟 side panel 同步高亮，以及展示時沒有對外的網路請求。
 * 展示的進度（辨識中 → 翻譯中 → 完成、剩餘頁數）是 site/src/demo/demo-state.test.ts。
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { demoPage } from '../site/src/demo/demo-page.ts';

const DIST = new URL('../site/dist/', import.meta.url);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** site/dist 的靜態 server（跟正式部署一樣，目錄的網址回傳裡面的 index.html）。 */
const test = base.extend<{ siteOrigin: string }>({
  siteOrigin: async ({}, use) => {
    const server: Server = createServer(async (req, res) => {
      const path = new URL(req.url!, 'http://site').pathname.replace(/\/$/, '/index.html').slice(1);
      try {
        const body = await readFile(new URL(decodeURIComponent(path), DIST));
        res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await use(`http://127.0.0.1:${port}`);
    await new Promise((resolve) => server.close(resolve));
  },
});

test('首頁展示：點圖示 → 翻譯完成 → 切到學習 → 滑過對話框看到 tooltip，全程不連外', async ({ page, siteOrigin }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${siteOrigin}/zh-tw/`);

  const demo = page.locator('.demo-chrome');
  await demo.getByRole('button', { name: 'Naruhodo', exact: true }).click();
  // Playwright 的 locator 會穿進 open shadow root
  const panel = demo.locator('.naru-side-panel');
  await expect(panel.getByRole('status', { name: '剩餘額度' })).toHaveText(/免費額度剩 49 頁/);

  const balloons = demoPage.text.balloons;
  const translations = demo.locator('[data-naruhodo-overlay] [data-balloon-id]');
  await expect(translations.filter({ visible: true })).toHaveCount(balloons.length);

  await panel.getByRole('button', { name: /^學習/ }).click();
  await expect(translations.filter({ visible: true })).toHaveCount(0);

  // 譯文元素藏起來後 rect 不變（visibility），拿它當 Balloon 的位置；漫畫頁會捲動，先捲到看得到
  const first = translations.first();
  await first.scrollIntoViewIfNeeded();
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const tooltip = demo.locator('[data-naruhodo-overlay] .tip.on');
  await expect(tooltip).toHaveCount(1);
  const id = await first.getAttribute('data-balloon-id');
  // 學習時 tooltip 是原文夾著振り仮名（rt），拿掉再比
  const withoutRuby = await tooltip.evaluate((tip) => {
    const copy = tip.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('rt').forEach((rt) => rt.remove());
    return copy.textContent;
  });
  expect(withoutRuby).toContain(balloons.find((b) => b.id === id)!.原文);
  // 同步高亮：side panel 逐字稿裡那句也亮起來
  await expect(panel.locator('li.hl')).toHaveCount(1);

  expect(requests.filter((url) => !url.startsWith(`${siteOrigin}/`))).toEqual([]);
});
