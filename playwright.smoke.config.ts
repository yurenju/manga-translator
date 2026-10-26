import { defineConfig } from '@playwright/test';

// 第 4 層（spec #27 第 12 節）：在外掛裡呼叫真的 Claude API。`npm run smoke` 才跑，不放進 `npm run e2e`。
export default defineConfig({
  testDir: 'e2e/smoke',
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
});
