/**
 * 用 launchPersistentContext＋--load-extension 載入 dist/e2e（spec #27 第 12 節）。
 * 用 Playwright 內建的 Chromium（channel: 'chromium'），新版一般 Chrome 已不接受 --load-extension。
 */
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { Message } from '../src/shared/messages.ts';
import { startMockSite, type MockSite } from './mock-site/server.ts';

const EXTENSION_DIR = fileURLToPath(new URL('../dist/e2e', import.meta.url));

export const test = base.extend<{
  /**
   * 真的 DPR（--force-device-scale-factor）。Playwright 的 deviceScaleFactor 只模擬頁面上的
   * devicePixelRatio，captureVisibleTab 的截圖仍是 1×，而且不能跟 viewport: null 一起用。
   */
  realDeviceScaleFactor: number | undefined;
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  mockSite: MockSite;
}>({
  realDeviceScaleFactor: [undefined, { option: true }],
  context: async ({ realDeviceScaleFactor }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        // 真的視窗大小。用 test.use({ viewport: null }) 的測試靠它；其他測試的 viewport 是模擬的，不受影響。
        '--window-size=1280,1500',
        ...(realDeviceScaleFactor === undefined ? [] : [`--force-device-scale-factor=${realDeviceScaleFactor}`]),
      ],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  mockSite: async ({}, use) => {
    const site = await startMockSite();
    await use(site);
    await site.close();
  },
});

export const expect = test.expect;

/** 打開仿 Jump+ 並等全部 canvas 畫完。 */
export async function openJumpPlus(context: BrowserContext, site: MockSite): Promise<Page> {
  const page = await context.newPage();
  await page.goto(site.jumpPlusUrl);
  await page.locator('body[data-ready="true"]').waitFor();
  return page;
}

export async function tabIdOf(sw: Worker, url: string): Promise<number> {
  const id = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, url);
  if (id === undefined) throw new Error(`no tab with url ${url}`);
  return id;
}

/**
 * 把 side panel 當一般分頁打開。給 tabId 就等同點圖示後打開的 tab 專屬 panel；
 * 不給就等同從 Chrome 內建 side panel 選單打開。
 */
export async function openSidePanel(context: BrowserContext, extensionId: string, tabId?: number): Promise<Page> {
  const panel = await context.newPage();
  const query = tabId === undefined ? '' : `?tabId=${tabId}`;
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html${query}`);
  return panel;
}

/** e2e 測試入口：等同點外掛圖示，SW 會呼叫同一個 activate(tabId)。 */
export async function testActivate(fromExtensionPage: Page, tabId: number): Promise<void> {
  await fromExtensionPage.evaluate(
    (message) => chrome.runtime.sendMessage(message),
    { type: 'test:activate', tabId } satisfies Message,
  );
}

/**
 * 打開仿 Jump+ 與它的 side panel，透過測試入口啟動，等 panel 顯示「已啟動」。
 * side panel 在這裡是另一個分頁，所以啟動前把仿 Jump+ 切回前景，跟真的點圖示時一樣是作用中 tab，
 * captureVisibleTab 才截得到它。
 */
export async function activateOnJumpPlus(
  { context, sw, extensionId, mockSite }: { context: BrowserContext; sw: Worker; extensionId: string; mockSite: MockSite },
): Promise<{ page: Page; panel: Page; tabId: number }> {
  const page = await openJumpPlus(context, mockSite);
  const tabId = await tabIdOf(sw, mockSite.jumpPlusUrl);
  const panel = await openSidePanel(context, extensionId, tabId);
  await page.bringToFront();
  await testActivate(panel, tabId);
  await expect(panel.getByText('已啟動')).toBeVisible();
  return { page, panel, tabId };
}

/** 在 content script 的 isolated world 裡看它在不在。 */
export async function isContentScriptInjected(sw: Worker, tabId: number): Promise<boolean> {
  return sw.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__mangaTranslator?.active === true,
    });
    return result?.result === true;
  }, tabId);
}
