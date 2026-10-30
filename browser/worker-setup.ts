import { startWorker } from './worker.ts';

/**
 * browser test 整輪只啟動一次本機 Worker（spec #86）：`wrangler dev --env test`，本機 D1、Anthropic 是 FakeTranslator。
 * 外掛與 Worker 之間的契約只有這一層測得到，所以不在 Playwright 裡攔網路。回傳的函式在測試結束時關掉它。
 */
export default function globalSetup(): Promise<() => Promise<void>> {
  return startWorker({ env: 'test' });
}
