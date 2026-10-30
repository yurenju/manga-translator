import { defineConfig } from '@playwright/test';
import type { TestOptions } from './browser/fixtures.ts';

// 真的 Paddle sandbox（#94）：`npm run smoke:paddle` 才跑，不放進 `npm run test:browser`。Worker、tunnel、產品網站由測試自己啟動。
// OCR 用 FakeEngine（這條不看翻譯）。
export default defineConfig<TestOptions>({
  testDir: 'browser/smoke-paddle',
  workers: 1,
  retries: 0,
  use: { fakeOcr: true },
  reporter: [['list']],
});
