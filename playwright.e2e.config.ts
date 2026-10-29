import { defineConfig } from '@playwright/test';
import type { TestOptions } from './browser/fixtures.ts';

// e2e（ADR 0007）：標 @e2e 的少數主要流程，跑真的 OCR 模型（wasm），LLM 仍是 FakeTranslator。
// 先跑 `npm run build:e2e`（`npm run e2e` 會自動做）。
export default defineConfig<TestOptions>({
  testDir: 'browser',
  testIgnore: ['smoke/**', 'record-ocr.spec.ts'],
  grep: /@e2e/,
  globalSetup: './browser/global-setup.ts',
  timeout: 30_000,
  // 一次一個瀏覽器，不互搶 CPU；真的太慢再加
  workers: 1,
  // 真模型受機器負載影響；重跑才過的會在 list reporter 標成 flaky
  retries: 1,
  use: { fakeOcr: false },
  reporter: [['list']],
});
