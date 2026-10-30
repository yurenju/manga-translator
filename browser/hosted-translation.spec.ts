/**
 * Hosted Translation：外掛連 globalSetup 啟動的本機 Worker（wrangler dev --env test，Anthropic 是 FakeTranslator、寄信是假的實作）。
 * 用 email 驗證碼登入（驗證碼從假的寄信實作的 outbox 取出）後翻完一頁；切回 Own API Key 時改走 offscreen 的 FakeTranslator，不經過 Worker。
 * unit 測不到的：side panel 與 SW 真的用 HTTP 打到 Worker、兩邊對 API 契約（路徑、token、輸入與回應格式）的理解一致，
 * session token 存進 IndexedDB 後 SW 讀得到，以及翻譯模式的設定一路傳到 SW。
 * 兩條路的譯文都來自同一份 ground truth，所以用 __translateCalls（只有走 offscreen 時才加）分辨走了哪一條。
 * 免費額度用完（#92）：Worker 回 402 → SW 的 Hosted Translator → side panel 重新向 Worker 讀額度，這串訊息與 API 契約只有這裡測得到；
 * 顯示規則（哪一行文字、警告色、按鈕）在 src/ui/view.test.ts。
 */
import type { Page } from '@playwright/test';
import { DEV_FREE_PAGES_PATH } from '../src/shared/hosted-api.ts';
import { activateOnJumpPlus, chooseFromPanelMenu, expect, openPanelMenu, test } from './fixtures.ts';
import { signInWithEmail } from './sign-in.ts';
import { WORKER_URL } from './worker.ts';

test.use({ viewport: null, fakeTranslator: true, requireApiKey: true });

const firstTranscript = (panel: Page) =>
  panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: '第 1 頁' }).getByRole('list', { name: '逐字稿' });

const freshEmail = (workerIndex: number) => `reader-${workerIndex}-${Date.now()}@example.com`;

test('用 email 驗證碼登入後，內建翻譯經過本機 Worker 翻完一頁；切到自備 API key 時不經過 Worker', async ({ context, sw, extensionId, mockSite }, testInfo) => {
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  const transcript = firstTranscript(panel);
  await expect(transcript.getByText('未翻譯').first()).toBeVisible();

  // 內建翻譯、還沒登入：逐字稿上方提示「尚未登入」，不用 API key
  await chooseFromPanelMenu(panel, 'API key 與模型');
  const settings = panel.getByRole('region', { name: 'API key 與模型' });
  const mode = settings.getByRole('group', { name: '翻譯方式' });
  await mode.getByRole('button', { name: '內建翻譯' }).click();
  await expect(settings.getByLabel('Claude API key')).toHaveCount(0);
  const signedOut = panel.getByRole('group', { name: '尚未登入' });
  await expect(signedOut).toBeVisible();

  // 同意並登入：寄送 → 從假的寄信取出驗證碼 → 登入（同意在這一步取得，不另外顯示資料使用說明卡）
  await signedOut.getByRole('button', { name: '登入' }).click();
  await signInWithEmail(settings, freshEmail(testInfo.workerIndex));
  await expect(signedOut).toHaveCount(0);
  await expect(panel.getByRole('region', { name: '資料使用說明' })).toHaveCount(0);

  await panel.getByRole('button', { name: '翻譯此頁' }).click();
  await expect(transcript.getByText('早安！今天好早喔')).toBeVisible();
  expect(await sw.evaluate(() => globalThis.__translateCalls)).toBe(0);

  // 自備 API key：同一頁重新翻譯，改走 offscreen
  await mode.getByRole('button', { name: '自備 API key' }).click();
  await settings.getByLabel('Claude API key').fill('sk-ant-e2e-not-a-real-key-WXYZ');
  await settings.getByRole('button', { name: '儲存' }).click();
  await panel.getByRole('button', { name: '重新翻譯' }).click();
  await expect.poll(() => sw.evaluate(() => globalThis.__translateCalls)).toBeGreaterThan(0);
  await expect(transcript.getByText('早安！今天好早喔')).toBeVisible();
});

test('免費額度用完：Worker 回額度不足後，side panel 顯示用完的狀態，逐字稿仍有原文與讀音', async ({ context, sw, extensionId, mockSite }, testInfo) => {
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  // 關掉自動翻譯：登入後只有按「翻譯此頁」才會送到 Worker，額度與按鈕不會被背景的翻譯搶先改掉
  await (await openPanelMenu(panel)).getByRole('switch', { name: '自動翻譯' }).uncheck();
  await chooseFromPanelMenu(panel, 'API key 與模型');
  const settings = panel.getByRole('region', { name: 'API key 與模型' });
  await settings.getByRole('group', { name: '翻譯方式' }).getByRole('button', { name: '內建翻譯' }).click();
  const email = freshEmail(testInfo.workerIndex);
  await signInWithEmail(settings, email);
  const remaining = panel.getByRole('status', { name: '剩餘額度' });
  await expect(remaining).toHaveText(/免費額度剩 50 頁/);

  // 登入後才把額度用完：side panel 還不知道，要等翻譯被 Worker 拒絕才換畫面
  const response = await fetch(`${WORKER_URL}${DEV_FREE_PAGES_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, remaining: 0 }),
  });
  expect(response.status).toBe(204);
  await panel.getByRole('button', { name: '翻譯此頁' }).click();

  const exhausted = panel.getByRole('group', { name: '免費額度已用完' });
  await expect(exhausted).toBeVisible();
  await expect(exhausted.getByRole('button', { name: '使用自備金鑰' })).toBeVisible();
  await expect(remaining).toHaveText('免費額度已用完');
  await expect(panel.getByRole('contentinfo').getByRole('button', { name: '訂閱' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '翻譯此頁' })).toHaveCount(0);
  // 不是「翻譯失敗」：原文、kuromoji 推測的讀音與「未翻譯」
  const transcript = firstTranscript(panel);
  await expect(panel.getByText(/翻譯失敗/)).toHaveCount(0);
  await expect(transcript.getByText('讀音為推測').first()).toBeVisible();
  await expect(transcript.getByText('未翻譯').first()).toBeVisible();
});
