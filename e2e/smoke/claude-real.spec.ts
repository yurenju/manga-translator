/**
 * 第 4 層（spec #27 第 12 節）：在外掛裡呼叫真的 Claude API（`npm run smoke`）。
 * - 正式 build（沒有 host_permissions）：設定區「測試連線」成功＝offscreen 直接 fetch 的 CORS 在真的外掛裡也過得去
 *   （#15 只用 curl 模擬過 chrome-extension:// origin）。
 * - e2e build：仿 Jump+ 的 p01 經過本機 OCR 後送給 Haiku 5.5，逐字稿出現譯文，狀態列顯示模型・秒數・費用。
 * 沒有 key 時跳過並印出「已跳過」。key 只在這個測試程序裡讀，不印出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { build } from '../../scripts/build.ts';
import { readTestApiKey, TEST_API_KEY_FILE } from '../../src/testing/test-api-key.ts';
import { activateOnJumpPlus, expect, launchWithExtension, openSidePanel, test } from '../fixtures.ts';

const apiKey = readTestApiKey();
if (!apiKey) console.log(`已跳過：沒有 NARUHODO_ANTHROPIC_KEY，也沒有 ${TEST_API_KEY_FILE}`);
test.skip(!apiKey, '沒有測試用 API key');

async function saveKey(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: '設定' }).click();
  const settings = panel.getByRole('region', { name: '設定' });
  await settings.getByLabel('Claude API key').fill(apiKey!);
  await settings.getByRole('button', { name: '儲存' }).click();
  await expect(settings).toContainText('末四碼');
}

test('正式 build（沒有 host_permissions）：「測試連線」成功', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'manga-prod-smoke-'));
  try {
    await build({ e2e: false, outDir });
    const context = await launchWithExtension('', undefined, outDir);
    try {
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const panel = await openSidePanel(context, new URL(sw.url()).host);
      await saveKey(panel);
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

    const status = panel.getByRole('contentinfo', { name: '狀態列' });
    await expect(status).toContainText('claude-haiku-5-5', { timeout: 100_000 });
    const text = await status.innerText();
    console.log('狀態列', text);
    expect(text).toMatch(/\d+\.\d 秒/);
    expect(text).toMatch(/\$0\.\d{5}/);
    const first = panel.getByRole('list', { name: 'Page' }).getByRole('listitem').filter({ has: panel.getByRole('img') }).first();
    const lines = await first.getByRole('list', { name: '逐字稿' }).getByRole('listitem').allInnerTexts();
    console.log('p01 逐字稿\n' + lines.map((l) => l.replace(/\n/g, ' / ')).join('\n'));
    await expect(first.locator('.translation').first()).toBeVisible();
    await expect(panel.getByText('翻譯失敗')).toHaveCount(0);
  });
});
