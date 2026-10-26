/**
 * 用 launchPersistentContext＋--load-extension 載入 dist/e2e（spec #27 第 12 節）。
 * 用 Playwright 內建的 Chromium（channel: 'chromium'），新版一般 Chrome 已不接受 --load-extension。
 */
import { fileURLToPath } from 'node:url';
import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { Message, PipelineConfig, TestConfig } from '../src/shared/messages.ts';
import { startMockSite, type MockSite } from './mock-site/server.ts';

const EXTENSION_DIR = fileURLToPath(new URL('../dist/e2e', import.meta.url));

/**
 * userDataDir 給 '' 是每次全新的暫存設定檔；給同一個目錄就能模擬「重開瀏覽器」。
 * extensionDir 預設是 dist/e2e；smoke test 也用它載入正式 build。
 */
export function launchWithExtension(
  userDataDir: string,
  realDeviceScaleFactor?: number,
  extensionDir = EXTENSION_DIR,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // 真的視窗大小。用 test.use({ viewport: null }) 的測試靠它；其他測試的 viewport 是模擬的，不受影響。
      '--window-size=1280,1500',
      ...(realDeviceScaleFactor === undefined ? [] : [`--force-device-scale-factor=${realDeviceScaleFactor}`]),
    ],
  });
}

/**
 * e2e 的本機流水線設定：模型從 mock site 下載、強制 wasm；Playwright 平行開好幾個瀏覽器，
 * 每個都開滿執行緒會互搶 CPU，讓不相干的測試（截圖、縮圖）逾時，所以限 2 條（仍可驗證多執行緒有開）。
 */
export const E2E_PIPELINE = (site: MockSite): PipelineConfig => ({
  modelBaseUrl: site.modelBaseUrl,
  executionProvider: 'wasm',
  maxThreads: 2,
});

/**
 * 取得 SW 並在建立任何 Page 之前設定：模型從 mock site 下載（內容是 repo 外的模型快取）、強制 wasm
 * （spec 第 12 節：自動測試預設跑 wasm），需要時改用 FakeTranslator。
 */
export async function configuredServiceWorker(
  context: BrowserContext,
  site: MockSite,
  fakeTranslator = false,
  translatorOptions: Pick<TestConfig, 'requireApiKey' | 'unreadableTexts'> = {},
): Promise<Worker> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const config: TestConfig = { pipeline: E2E_PIPELINE(site), fakeTranslator, ...translatorOptions };
  await sw.evaluate((config) => globalThis.__configureForTest!(config), config);
  return sw;
}

export const test = base.extend<{
  /**
   * 真的 DPR（--force-device-scale-factor）。Playwright 的 deviceScaleFactor 只模擬頁面上的
   * devicePixelRatio，captureVisibleTab 的截圖仍是 1×，而且不能跟 viewport: null 一起用。
   */
  realDeviceScaleFactor: number | undefined;
  /** 用 FakeTranslator（合成頁 ground truth 的讀音與譯文）；預設 false＝沒有 API key。 */
  fakeTranslator: boolean;
  /** 跟正式 build 一樣要先在設定區存 API key 才翻譯；預設 false＝FakeTranslator 不需要 key。 */
  requireApiKey: boolean;
  /** FakeTranslator 當成無法辨識的 ground truth 原文。 */
  unreadableTexts: string[];
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  mockSite: MockSite;
}>({
  realDeviceScaleFactor: [undefined, { option: true }],
  context: async ({ realDeviceScaleFactor }, use) => {
    const context = await launchWithExtension('', realDeviceScaleFactor);
    await use(context);
    await context.close();
  },
  fakeTranslator: [false, { option: true }],
  requireApiKey: [false, { option: true }],
  unreadableTexts: [[], { option: true }],
  sw: async ({ context, mockSite, fakeTranslator, requireApiKey, unreadableTexts }, use) => {
    await use(await configuredServiceWorker(context, mockSite, fakeTranslator, { requireApiKey, unreadableTexts }));
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
export async function openJumpPlus(context: BrowserContext, site: MockSite, url = site.jumpPlusUrl): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
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
  {
    context,
    sw,
    extensionId,
    mockSite,
    beforeActivate,
    url = mockSite.jumpPlusUrl,
  }: {
    context: BrowserContext;
    sw: Worker;
    extensionId: string;
    mockSite: MockSite;
    /** side panel 打開後、啟動前（例如在 panel 裡掛 listener）。 */
    beforeActivate?: (panel: Page) => Promise<void>;
    /** 預設是縱向排列的仿 Jump+；翻頁版用 mockSite.jumpPlusPagedUrl。 */
    url?: string;
  },
): Promise<{ page: Page; panel: Page; tabId: number }> {
  const page = await openJumpPlus(context, mockSite, url);
  const tabId = await tabIdOf(sw, url);
  const panel = await openSidePanel(context, extensionId, tabId);
  await beforeActivate?.(panel);
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
