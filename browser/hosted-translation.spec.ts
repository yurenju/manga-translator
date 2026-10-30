/**
 * Hosted Translation：外掛連 globalSetup 啟動的本機 Worker（wrangler dev --env test，Anthropic 是 FakeTranslator、寄信是假的實作）。
 * 全新安裝（#93）：SW 處理安裝事件 → 打開 onboarding 分頁 → 用 email 驗證碼登入（驗證碼從假的寄信實作的 outbox 取出）→
 * 先用免費額度 → 在仿 Jump+ 翻完一頁；切到自備金鑰時改走 offscreen 的 FakeTranslator，不經過 Worker。
 * unit 測不到的：SW 真的打開 onboarding 分頁、onboarding 頁與 side panel 與 SW 透過 chrome.storage／IndexedDB／訊息接起來，
 * side panel 與 SW 真的用 HTTP 打到 Worker、兩邊對 API 契約（路徑、token、輸入與回應格式）的理解一致。
 * 安裝時怎麼決定翻譯模式與 onboarding 在 src/background/install.test.ts。
 * 兩條路的譯文都來自同一份 ground truth，所以用 __translateCalls（只有走 offscreen 時才加）分辨走了哪一條。
 * 免費額度用完（#92）：Worker 回 402 → SW 的 Hosted Translator → side panel 重新向 Worker 讀額度，這串訊息與 API 契約只有這裡測得到；
 * 顯示規則（哪一行文字、警告色、按鈕）在 src/ui/view.test.ts。
 * 訂閱（#94）：side panel 的「訂閱」向 Worker 建立 checkout、用新分頁打開 checkout 頁 → Paddle 的 webhook 送到 Worker →
 * side panel 重新取得焦點時重讀額度、顯示本月額度。Worker 的 Paddle 是假的（env.test），webhook 由測試用 env.test 的 secret 簽好送出；
 * 真的 Paddle sandbox 只在 `npm run smoke:paddle`。webhook 與額度的規則在 worker/src/subscription.test.ts。
 * 刪除帳號（#95）：設定頁 → 確認頁 → Worker 的 DELETE /v1/account → 清掉 session → side panel 回到未登入。刪除的規則在
 * worker/src/account-deletion.test.ts，清掉 session 的流程在 src/shared/account-exit.test.ts。
 */
import { createHmac } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { DEV_FREE_PAGES_PATH, PADDLE_WEBHOOK_PATH } from '../src/shared/hosted-api.ts';
import { activateOnJumpPlus, chooseFromPanelMenu, expect, openPanelMenu, test } from './fixtures.ts';
import { finishOnboarding, onboardingPage, signInFromPanel, signInWithEmail } from './sign-in.ts';
import { WORKER_URL } from './worker.ts';

test.use({ viewport: null, fakeTranslator: true, requireApiKey: true });

const firstTranscript = (panel: Page) =>
  panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: '第 1 頁' }).getByRole('list', { name: '逐字稿' });

const freshEmail = (workerIndex: number) => `reader-${workerIndex}-${Date.now()}@example.com`;

test.describe('全新安裝', () => {
  test.use({ freshInstall: true });

  test('onboarding 自動打開 → 同意並登入 → 先用免費額度 → 內建翻譯經過本機 Worker 翻完一頁；切到自備金鑰時不經過 Worker', async ({
    context,
    sw,
    extensionId,
    mockSite,
  }, testInfo) => {
    const onboarding = await onboardingPage(context);
    await onboarding.getByRole('button', { name: '開始設定' }).click();
    const email = freshEmail(testInfo.workerIndex);
    await signInWithEmail(onboarding, email);
    await onboarding.getByRole('button', { name: '先用免費的 50 頁' }).click();
    await expect(onboarding.getByRole('heading', { name: '開始翻譯' })).toBeVisible();
    await finishOnboarding(onboarding);

    // 設定完成：side panel 不再只顯示「完成設定」，自動翻譯直接經過 Worker 翻（同意在登入時取得，沒有資料使用說明卡）
    const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
    const transcript = firstTranscript(panel);
    await expect(transcript.getByText('早安！今天好早喔')).toBeVisible();
    await expect(panel.getByRole('region', { name: '資料使用說明' })).toHaveCount(0);
    expect(await sw.evaluate(() => globalThis.__translateCalls)).toBe(0);

    // 自備金鑰：設定頁切換（不會登出），同一頁重新翻譯改走 offscreen
    await chooseFromPanelMenu(panel, '設定');
    const settings = panel.getByRole('region', { name: '設定' });
    await settings.getByRole('radio', { name: '自備金鑰' }).check();
    await expect(settings).toContainText(`帳號 ${email} 仍然登入著`);
    await settings.getByLabel('Claude API key').fill('sk-ant-e2e-not-a-real-key-WXYZ');
    await settings.getByRole('button', { name: '儲存' }).click();
    await panel.getByRole('button', { name: '返回' }).click();
    // 自備金鑰的同意另外問（資料流向不同）
    await panel.getByRole('region', { name: '資料使用說明' }).getByRole('button', { name: '同意並啟用翻譯' }).click();
    await panel.getByRole('button', { name: '重新翻譯' }).click();
    await expect.poll(() => sw.evaluate(() => globalThis.__translateCalls)).toBeGreaterThan(0);
    await expect(transcript.getByText('早安！今天好早喔')).toBeVisible();
  });
});

/** wrangler.jsonc 的 env.test 的 PADDLE_WEBHOOK_SECRET（假值）。 */
const TEST_WEBHOOK_SECRET = 'pdl_ntfset_browser_test';

/** 像 Paddle 一樣簽好、送一個 subscription.created 給本機 Worker；custom_data 的 Account id 是 Worker 建立 transaction 時放的。 */
async function sendSubscriptionCreated(accountId: string): Promise<void> {
  const now = new Date().toISOString();
  const body = JSON.stringify({
    event_id: `evt_browser_${Date.now()}`,
    event_type: 'subscription.created',
    occurred_at: now,
    data: {
      id: `sub_browser_${accountId}`,
      status: 'active',
      customer_id: `ctm_browser_${accountId}`,
      started_at: now,
      current_billing_period: { starts_at: now, ends_at: new Date(Date.now() + 365 * 86_400_000).toISOString() },
      scheduled_change: null,
      custom_data: { account_id: accountId },
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac('sha256', TEST_WEBHOOK_SECRET).update(`${ts}:${body}`).digest('hex');
  const response = await fetch(`${WORKER_URL}${PADDLE_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};h1=${h1}` },
    body,
  });
  expect(response.status).toBe(200);
}

/** 登入一個免費帳號、關掉自動翻譯（剩餘頁數不會被背景的翻譯改掉），回到逐字稿。 */
async function signInOnPanel(panel: Page, context: BrowserContext, email: string): Promise<void> {
  await (await openPanelMenu(panel)).getByRole('switch', { name: '自動翻譯' }).uncheck();
  await chooseFromPanelMenu(panel, '設定');
  const settings = panel.getByRole('region', { name: '設定' });
  await settings.getByRole('radio', { name: '內建翻譯' }).check();
  // 設定頁的「登入」打開 onboarding 的第 2 步
  await signInFromPanel(context, () => settings.getByRole('button', { name: '登入' }).click(), email);
  await expect(settings.getByText(email)).toBeVisible();
  await panel.getByRole('button', { name: '返回' }).click();
}

test('訂閱：side panel 的「訂閱」用新分頁打開 checkout 頁；webhook 送到 Worker 後，side panel 重新取得焦點就顯示本月額度', async ({
  context,
  sw,
  extensionId,
  mockSite,
}, testInfo) => {
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  await signInOnPanel(panel, context, freshEmail(testInfo.workerIndex));
  const remaining = panel.getByRole('status', { name: '剩餘額度' });
  await expect(remaining).toHaveText(/免費額度剩 50 頁/);

  // 本機的產品網站沒有啟動，只看網址：Worker 自己組的 checkout 頁，transaction id（假 Paddle 帶 Account id）。
  // 網站回空白頁：連不上的話網址會變成 chrome-error://（Linux 上立刻就變），就看不到原本的網址
  await context.route('http://localhost:4321/**', (route) => route.fulfill({ contentType: 'text/html', body: '' }));
  const opened = context.waitForEvent('page');
  await remaining.getByRole('button', { name: '訂閱' }).click();
  const checkout = await opened;
  await expect.poll(() => checkout.url()).toMatch(/^http:\/\/localhost:4321\/zh-tw\/checkout\?_ptxn=txn_fake_/);
  const accountId = new URL(checkout.url()).searchParams.get('_ptxn')!.replace('txn_fake_', '');

  await sendSubscriptionCreated(accountId);
  await checkout.close();
  // 讀者付完款切回來，side panel 重新取得焦點。Playwright 模擬每個頁面一直都有焦點、一直可見，不會送出 focus／visibilitychange，
  // 所以由測試代替瀏覽器送 focus 事件；之後向 Worker 重讀額度是外掛自己做的
  await panel.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(remaining).toHaveText(/^本月剩 800 頁・\d+ 月 \d+ 日重置$/);
  await chooseFromPanelMenu(panel, '設定');
  const settings = panel.getByRole('region', { name: '設定' });
  await expect(settings.getByText('訂閱中', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '管理訂閱' })).toBeVisible();
});

test('免費額度用完：Worker 回額度不足後，side panel 顯示用完的狀態，逐字稿仍有原文與讀音', async ({ context, sw, extensionId, mockSite }, testInfo) => {
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  // 關掉自動翻譯：登入後只有按「翻譯此頁」才會送到 Worker，額度與按鈕不會被背景的翻譯搶先改掉
  const email = freshEmail(testInfo.workerIndex);
  await signInOnPanel(panel, context, email);
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

  const exhausted = panel.getByRole('group', { name: '額度已用完' });
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

test('刪除帳號：設定頁的「刪除帳號」換到確認頁 → 確定刪除 → 回到設定頁是未登入，side panel 顯示「尚未登入」', async ({
  context,
  sw,
  extensionId,
  mockSite,
}, testInfo) => {
  const { panel } = await activateOnJumpPlus({ context, sw, extensionId, mockSite });
  const email = freshEmail(testInfo.workerIndex);
  await signInOnPanel(panel, context, email);
  await chooseFromPanelMenu(panel, '設定');
  await panel.getByRole('region', { name: '設定' }).getByRole('button', { name: '刪除帳號' }).click();

  const confirm = panel.getByRole('region', { name: '刪除帳號' });
  await expect(confirm).toContainText(`確定要刪除 ${email} 的帳號？`);
  await confirm.getByRole('button', { name: '刪除帳號' }).click();

  // Worker 刪除成功 → 外掛清掉 session → 回到設定頁，內建翻譯卡片是未登入
  const settings = panel.getByRole('region', { name: '設定' });
  await expect(settings.getByText('尚未登入。')).toBeVisible();
  await expect(settings.getByRole('button', { name: '登入' })).toBeVisible();
  await panel.getByRole('button', { name: '返回' }).click();
  await expect(panel.getByRole('group', { name: '尚未登入' })).toBeVisible();
});
