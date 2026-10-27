/**
 * #31：side panel 設定區輸入 API key → 「翻譯此頁」→ 逐字稿出現讀音與譯文、狀態列顯示模型・秒數・費用。
 * FakeTranslator 取代 Claude，但跟正式 build 一樣要先存 key（requireApiKey）。
 * 也檢查 key 不經過 content script 與 messaging（spec #27 第 5 節）。
 */
import type { Page, Worker } from '@playwright/test';
import { activateOnJumpPlus, expect, openSidePanel, test } from './fixtures.ts';

test.use({ viewport: null, fakeTranslator: true, requireApiKey: true, unreadableTexts: ['もちろん！'] });

const TRANSCRIPT_TIMEOUT = 60_000;
const FAKE_KEY = 'sk-ant-e2e-not-a-real-key-WXYZ';

const firstTranscript = (panel: Page) =>
  panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: '第 1 頁' }).getByRole('list', { name: '逐字稿' });

/** 在 side panel 裡記下所有 runtime 訊息（SW ↔ offscreen 的 sendMessage 也會廣播到這裡）。 */
async function recordPanelMessages(panel: Page): Promise<void> {
  await panel.evaluate(() => {
    const g = globalThis as unknown as { __seen: string[] };
    g.__seen = [];
    chrome.runtime.onMessage.addListener((m: unknown) => void g.__seen.push(JSON.stringify(m)));
  });
}

/** 在 content script 的 isolated world 裡記下它收到的所有訊息。 */
async function recordContentMessages(sw: Worker, tabId: number): Promise<void> {
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const g = globalThis as unknown as { __seen: string[] };
        g.__seen = [];
        chrome.runtime.onMessage.addListener((m: unknown) => void g.__seen.push(JSON.stringify(m)));
      },
    });
  }, tabId);
}

/** content script 收到的訊息，以及它的 IndexedDB（頁面的 origin）裡有沒有 API key 的 store。 */
async function contentScriptView(sw: Worker, tabId: number) {
  return sw.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('naruhodo');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const stores = [...db.objectStoreNames];
        db.close();
        return { seen: (globalThis as unknown as { __seen: string[] }).__seen, stores };
      },
    });
    return result!.result!;
  }, tabId);
}

test('設定 API key 後按「翻譯此頁」：逐字稿出現譯文、狀態列顯示模型・秒數・費用；key 不經過 content script', async ({
  context,
  sw,
  extensionId,
  mockSite,
}) => {
  test.setTimeout(TRANSCRIPT_TIMEOUT + 30_000);
  const { panel, tabId } = await activateOnJumpPlus({ context, sw, extensionId, mockSite, beforeActivate: recordPanelMessages });
  await recordContentMessages(sw, tabId);

  // 還沒有 key：原文＋kuromoji 讀音、未翻譯
  const transcript = firstTranscript(panel);
  await expect(transcript.getByRole('listitem').first()).toBeVisible({ timeout: TRANSCRIPT_TIMEOUT });
  await expect(transcript.getByText('未翻譯').first()).toBeVisible();
  await expect(panel.getByText('尚未設定 API key')).toBeVisible();

  // 設定區：輸入 key，只顯示末四碼
  await panel.getByRole('button', { name: '設定' }).click();
  const settings = panel.getByRole('region', { name: '設定' });
  await expect(settings).toContainText('Anthropic Console');
  await expect(settings).toContainText('花費上限');
  await settings.getByLabel('Claude API key').fill(FAKE_KEY);
  await settings.getByRole('button', { name: '儲存' }).click();
  await expect(settings).toContainText('末四碼 WXYZ');
  await expect(settings.getByLabel('Claude API key')).toHaveCount(0);
  expect(await panel.locator('body').innerText()).not.toContain(FAKE_KEY);
  await expect(panel.getByText('尚未設定 API key')).toHaveCount(0);

  // 翻譯此頁
  await panel.getByRole('button', { name: '翻譯此頁' }).click();
  await expect(transcript.getByText('早安！今天好早喔')).toBeVisible({ timeout: TRANSCRIPT_TIMEOUT });
  // 讀音換成 Translator 的整句讀音（おはよう！きょうははやいね），以ルビ對齊回漢字
  await expect(transcript.getByRole('listitem').filter({ hasText: '早安！今天好早喔' }).locator('rt')).toHaveText(['きょう', 'はや']);
  const status = panel.getByRole('contentinfo', { name: '狀態列' });
  await expect(status).toContainText('已翻譯');
  await expect(status).toContainText('fake');
  await expect(status).toContainText(/\d+\.\d 秒/);
  await expect(status).toContainText('$0.00000');
  console.log('狀態列', await status.innerText());
  await expect(panel.getByRole('button', { name: '重新翻譯' })).toBeVisible();

  // unreadable：OCR 原文（灰、刪除線）＋「無法辨識 · 未覆蓋」
  const unreadable = transcript.getByRole('listitem').filter({ hasText: '無法辨識' });
  await expect(unreadable).toHaveCount(1);
  await expect(unreadable).toContainText('もちろん');
  const original = unreadable.locator('[lang="ja"]');
  await expect(original).toHaveCSS('text-decoration-line', 'line-through');
  // 灰＝design token --naru-ink-3（#75706A）
  await expect(original).toHaveCSS('color', 'rgb(117, 112, 106)');
  await expect(unreadable.locator('[lang="zh-Hant"]')).toHaveCount(0);
  await expect(unreadable.getByText('未翻譯')).toHaveCount(0);

  // key 不在任何 runtime 訊息裡，content script 也拿不到
  const panelSeen = await panel.evaluate(() => (globalThis as unknown as { __seen: string[] }).__seen);
  expect(panelSeen.some((m) => m.includes('offscreen:translate'))).toBe(true);
  expect(panelSeen.filter((m) => m.includes(FAKE_KEY))).toEqual([]);
  const content = await contentScriptView(sw, tabId);
  expect(content.seen.filter((m) => m.includes(FAKE_KEY))).toEqual([]);
  expect(content.stores).not.toContain('apiKeys');

  // 刪除 key
  await settings.getByRole('button', { name: '刪除' }).click();
  await expect(settings.getByLabel('Claude API key')).toBeVisible();
  await expect(settings).not.toContainText('末四碼');
});

test('從 Chrome 內建 side panel 選單打開（沒有啟動 tab）也能設定 API key', async ({ context, extensionId }) => {
  const panel = await openSidePanel(context, extensionId);

  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await panel.getByRole('button', { name: '設定' }).click();
  const settings = panel.getByRole('region', { name: '設定' });
  await settings.getByLabel('Claude API key').fill(FAKE_KEY);
  await settings.getByRole('button', { name: '儲存' }).click();
  await expect(settings).toContainText('末四碼 WXYZ');

  // 重新打開 side panel 仍然記得（存在 IndexedDB）
  await panel.reload();
  await panel.getByRole('button', { name: '設定' }).click();
  await expect(panel.getByRole('region', { name: '設定' })).toContainText('末四碼 WXYZ');
});
