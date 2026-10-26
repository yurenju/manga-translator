import { defineConfig } from '@playwright/test';

// 外掛從 dist/e2e 載入，先跑 `npm run build:e2e`（`npm run e2e` 會自動做）。
export default defineConfig({
  testDir: 'e2e',
  // 呼叫真的 API 的第 4 層在 playwright.smoke.config.ts（npm run smoke）
  testIgnore: 'smoke/**',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  reporter: [['list']],
});
