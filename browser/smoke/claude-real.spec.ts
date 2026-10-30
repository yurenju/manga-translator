/**
 * 第 4 層（spec #27 第 12 節）：在外掛裡呼叫真的 Claude API（`npm run smoke`）。
 * - 正式 build（沒有 host_permissions）：全新安裝打開的 onboarding 用「使用自備金鑰」存 key，設定頁「測試連線」成功＝offscreen 直接 fetch 的 CORS 在真的外掛裡也過得去
 *   （#15 只用 curl 模擬過 chrome-extension:// origin）。
 * - e2e build：仿 Jump+ 的 p01 經過本機 OCR 後送給 Haiku 5.5，逐字稿出現譯文，狀態列顯示模型・秒數・費用。
 *   自備 API key 直接打 Anthropic 一次；內建翻譯經過本機 Worker（wrangler dev --env dev，用同一把 key）一次（#90），
 *   先用 email 驗證碼登入（env.dev 的寄信是假的實作，#91）。
 * 沒有 key 時跳過並印出「已跳過」。key 只在這個測試程序裡讀，不印出。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { build } from '../../scripts/build.ts';
import { readTestApiKey, TEST_API_KEY_FILE } from '../../src/testing/test-api-key.ts';
import { activateOnJumpPlus, chooseFromPanelMenu, expect, launchWithExtension, openSidePanel, test } from '../fixtures.ts';
import { onboardingPage, signInFromPanel } from '../sign-in.ts';
import { startWorker } from '../worker.ts';

const apiKey = readTestApiKey();
if (!apiKey) console.log(`已跳過：沒有 NARUHODO_ANTHROPIC_KEY，也沒有 ${TEST_API_KEY_FILE}`);
test.skip(!apiKey, '沒有測試用 API key');

async function saveKey(panel: Page): Promise<void> {
  await chooseFromPanelMenu(panel, '設定');
  const settings = panel.getByRole('region', { name: '設定' });
  await settings.getByLabel('Claude API key').fill(apiKey!);
  await settings.getByRole('button', { name: '儲存' }).click();
  await expect(settings).toContainText('末四碼');
  await panel.getByRole('button', { name: '返回' }).click();
}

test('正式 build（沒有 host_permissions）：「測試連線」成功', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'manga-prod-smoke-'));
  try {
    await build({ e2e: false, outDir });
    const context = await launchWithExtension('', undefined, outDir);
    try {
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      // 正式 build 會處理安裝事件：預設內建翻譯並打開 onboarding（#93），從頁尾改用自備金鑰
      const onboarding = await onboardingPage(context);
      await onboarding.getByRole('button', { name: '使用自備金鑰' }).click();
      await onboarding.getByLabel('Claude API key').fill(apiKey!);
      await onboarding.getByRole('button', { name: '同意並儲存' }).click();
      await expect(onboarding.getByRole('heading', { name: '開始翻譯' })).toBeVisible();
      const panel = await openSidePanel(context, new URL(sw.url()).host);
      await chooseFromPanelMenu(panel, '設定');
      await panel.getByRole('button', { name: '測試連線' }).click();
      await expect(panel.getByText('連線成功（claude-haiku-5-5）')).toBeVisible({ timeout: 30_000 });
    } finally {
      await context.close();
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test.describe('e2e build', () => {
  test.use({ viewport: null });

  test('仿 Jump+ 的 p01：本機 OCR → Haiku 5.5，逐字稿出現譯文與狀態列', async ({ context, sw, extensionId, mockSite }) => {
    const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, beforeActivate: saveKey });
    await acceptConsent(panel);

    await expectTranslatedP01(panel);
  });

  test('Hosted Translation：本機 OCR → 本機 Worker（wrangler dev --env dev）→ Haiku 5.5', async ({ context, sw, extensionId, mockSite }) => {
    // key 寫進只有這個測試用的暫存檔交給 wrangler（--env-file），不放在命令列參數裡
    const dir = await mkdtemp(join(tmpdir(), 'naruhodo-worker-env-'));
    const envFile = join(dir, '.dev.vars');
    await writeFile(envFile, `CLAUDE_API_KEY=${apiKey}\n`, { mode: 0o600 });
    const stopWorker = await startWorker({ env: 'dev', envFile });
    try {
      const { panel } = await activateOnJumpPlus({
        context,
        sw,
        extensionId,
        mockSite,
        async beforeActivate(panel) {
          await chooseFromPanelMenu(panel, '設定');
          const settings = panel.getByRole('region', { name: '設定' });
          await settings.getByRole('radio', { name: '內建翻譯' }).check();
          // 在 onboarding 登入時就取得資料使用同意，不另外按說明卡
          await signInFromPanel(context, () => settings.getByRole('button', { name: '登入' }).click(), `smoke-${Date.now()}@example.com`);
          await panel.getByRole('button', { name: '返回' }).click();
        },
      });

      await expectTranslatedP01(panel);
    } finally {
      await stopWorker();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** 同意之後才會送出文字。真的 OCR 這時還在跑，自動翻譯是開的，OCR 做完就會翻。 */
async function acceptConsent(panel: Page): Promise<void> {
  await panel.getByRole('region', { name: '資料使用說明' }).getByRole('button', { name: '同意並啟用翻譯' }).click();
}

/** 狀態列顯示模型・秒數・費用，p01 的逐字稿出現譯文。 */
async function expectTranslatedP01(panel: Page): Promise<void> {
  const status = panel.getByRole('contentinfo', { name: '狀態列' });
  await expect(status).toContainText('claude-haiku-5-5', { timeout: 100_000 });
  const text = await status.innerText();
  console.log('狀態列', text);
  expect(text).toMatch(/\d+\.\d 秒/);
  expect(text).toMatch(/\$0\.\d{5}/);
  const first = panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: '第 1 頁' });
  const lines = await first.getByRole('list', { name: '逐字稿' }).getByRole('listitem').allInnerTexts();
  console.log('p01 逐字稿\n' + lines.map((l) => l.replace(/\n/g, ' / ')).join('\n'));
  await expect(first.locator('[lang="zh-Hant"]').first()).toBeVisible();
  await expect(panel.getByText('翻譯失敗')).toHaveCount(0);
}
