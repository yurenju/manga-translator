/**
 * 用法：node scripts/icons.ts
 *   從 logo 母檔 src/icons/naruhodo.svg 產出外掛 icon 的 PNG（src/icons/icon-<size>.png）。
 *   改了母檔才需要重跑，產出的 PNG 跟母檔一起 commit；build 只負責複製（scripts/build.ts）。
 *
 * 用 Playwright 的 Chromium 畫：跟 Chrome 工具列的 SVG 算圖一致，也不用多裝一個 SVG 函式庫。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { ICON_SIZES } from '../src/manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

const svg = await readFile(join(root, 'src/icons/naruhodo.svg'), 'utf8');
const browser = await chromium.launch();
try {
  for (const size of ICON_SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: join(root, `src/icons/icon-${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`icons → src/icons/icon-{${ICON_SIZES.join(',')}}.png`);
