import { defineConfig } from '@playwright/test';
import type { TestOptions } from './browser/fixtures.ts';

// browser test（ADR 0007）：真的瀏覽器與外掛，OCR 用 FakeEngine、LLM 用 FakeTranslator，不下載模型。
// 外掛從 dist/e2e 載入，先跑 `npm run build:e2e`（`npm run test:browser` 會自動做）。
// 標 @e2e 的測試在這裡也跑（用 FakeEngine），playwright.e2e.config.ts 再用真的 OCR 跑一次；只對真模型有意義的會自己 skip。
// 呼叫真的 API 的在 playwright.smoke.config.ts。
export default defineConfig<TestOptions>({
  testDir: 'browser',
  // 錄 FakeEngine 重播結果的在 playwright.record.config.ts
  testIgnore: ['smoke/**', 'record-ocr.spec.ts'],
  timeout: 30_000,
  // FakeEngine 是確定性的：重跑才過代表程式本身有 race condition，直接紅
  retries: 0,
  use: { fakeOcr: true },
  reporter: [['list']],
});
