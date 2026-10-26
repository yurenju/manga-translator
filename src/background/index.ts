import { createFakeTranslator } from '../shared/fake-translator.ts';
import type {
  AnalyzeResponse,
  CropResponse,
  Message,
  ModelStatus,
  ModelStatusResponse,
  PageCandidatesResponse,
  PagesResponse,
  PipelineConfig,
  StatusResponse,
  TestConfig,
} from '../shared/messages.ts';
import type { Translator } from '../shared/translator.ts';
import { createActivation } from './activation.ts';
import { indexedDbPageCache, indexedDbSeriesStore } from './cache-store.ts';
import { ensureOffscreenDocument } from './offscreen.ts';
import { createScanner } from './scan.ts';
import { provisionalSeries } from './series.ts';
import { SYNTHETIC_GROUND_TRUTH } from './synthetic-ground-truth.ts';
import { indexedDbTabStore } from './tab-store.ts';
import { createTranscriber } from './transcribe.ts';

declare global {
  /** e2e build 才有：每次 captureVisibleTab 的時間，給測試檢查限速。 */
  var __captureLog: number[] | undefined;
  /** e2e build 才有：在建立任何 Page 之前呼叫（e2e/fixtures.ts）。 */
  var __configureForTest: ((config: TestConfig) => void) | undefined;
  /** e2e build 才有：FakeTranslator 被呼叫的次數（確認命中快取時沒有翻譯）。 */
  var __translateCalls: number | undefined;
}

const store = indexedDbTabStore();

// 瀏覽器重開後 tab id 會重新編號，上一次的啟動狀態都不算數。
chrome.runtime.onStartup.addListener(() => {
  void store.clear();
});

/** side panel 沒開時沒有接收者，sendMessage 會 reject，忽略即可。 */
function notifyPanel(message: Message): void {
  chrome.runtime.sendMessage(message).catch(() => {});
}

const scanner = createScanner({
  findPageCandidates: (tabId) =>
    chrome.tabs.sendMessage<Message, PageCandidatesResponse>(tabId, { type: 'content:findPageCandidates' }),
  async getVisibleWindowId(tabId) {
    const tab = await chrome.tabs.get(tabId);
    return tab.active ? tab.windowId : undefined;
  },
  captureWindow(windowId) {
    if (__E2E__) (globalThis.__captureLog ??= []).push(Date.now());
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  },
  async crop(request) {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, CropResponse>({ type: 'offscreen:crop', ...request });
    if ('error' in response) throw new Error(`crop failed: ${response.error}`);
    return response.pages;
  },
  publish(tabId, pages, capture) {
    if (capture) void transcriber.update(tabId, pages, capture);
    else transcriber.clear(tabId);
  },
});

/** e2e build 才會改（test:configure）。 */
let pipelineConfig: PipelineConfig = {};
let fakeTranslator: Translator | undefined;

const transcriber = createTranscriber({
  async analyze(request) {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, AnalyzeResponse>({
      type: 'offscreen:analyze',
      ...request,
      ...(__E2E__ ? { pipeline: pipelineConfig } : {}),
    });
    if ('error' in response) throw new Error(response.error);
    return response.text;
  },
  // Claude 與 API key 在 #31；沒有 key 時沒有 Translator（只顯示原文＋kuromoji 讀音）。
  getTranslator: () => (__E2E__ ? fakeTranslator : undefined),
  getSeriesId: (tabId) => activation.getSeriesId(tabId),
  cache: indexedDbPageCache(),
  publish(tabId, pages) {
    notifyPanel({ type: 'pages:updated', tabId, pages });
  },
});

let modelStatus: ModelStatus = { state: 'idle' };

if (__E2E__) {
  globalThis.__configureForTest = (config) => {
    pipelineConfig = config.pipeline;
    globalThis.__translateCalls = 0;
    const fake = createFakeTranslator(SYNTHETIC_GROUND_TRUTH);
    fakeTranslator = config.fakeTranslator
      ? {
          translatePage(input, signal) {
            globalThis.__translateCalls!++;
            return fake.translatePage(input, signal);
          },
        }
      : undefined;
  };
}

/** 頁面可能剛好換頁、content script 不在，或截圖失敗；這次掃描就放棄，等下一次觸發。 */
function scan(tabId: number): void {
  scanner.scan(tabId).catch((e: unknown) => console.warn('scan failed', e));
}

const seriesStore = indexedDbSeriesStore();

const activation = createActivation({
  store,
  async createProvisionalSeries(url) {
    const series = provisionalSeries(url, new Date(), crypto.randomUUID());
    await seriesStore.add(series);
    return series.id;
  },
  getTabUrl: async (tabId) => (await chrome.tabs.get(tabId)).url,
  openSidePanel(tabId) {
    // 不 await setOptions：await 會讓 open() 離開 user gesture。兩個呼叫會依序送到瀏覽器。
    // 用 tab 專屬的路徑帶上 tabId；從 Chrome 內建選單打開的是沒有 tabId 的全域 side panel。
    chrome.sidePanel
      .setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true })
      .catch((e: unknown) => console.warn('sidePanel.setOptions failed', e));
    return chrome.sidePanel.open({ tabId });
  },
  async injectContentScript(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  },
  async stopContentScript(tabId) {
    await chrome.tabs.sendMessage(tabId, { type: 'content:stop' } satisfies Message);
  },
  onStatusChanged(tabId, active) {
    notifyPanel({ type: 'status:changed', tabId, active });
    if (active) scan(tabId);
    else scanner.clear(tabId);
  },
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void activation.activate(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'activate' && tab?.id !== undefined) void activation.activate(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void activation.handleTabUpdated(tabId, changeInfo);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void activation.handleTabRemoved(tabId);
  scanner.clear(tabId);
});

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  // __E2E__ 是 build 時的常數，正式 build 裡這段會被整段移除。
  if (__E2E__ && message.type === 'test:activate') {
    activation.activate(message.tabId).then(() => sendResponse());
    return true;
  }
  switch (message.type) {
    case 'models:status':
      modelStatus = message.status;
      return false;
    case 'panel:getModelStatus':
      sendResponse({ status: modelStatus } satisfies ModelStatusResponse);
      return false;
    case 'panel:getStatus':
      activation.isActive(message.tabId).then((active) => sendResponse({ active } satisfies StatusResponse));
      return true;
    case 'panel:stop':
      activation.stop(message.tabId).then(() => sendResponse());
      return true;
    case 'panel:getPages':
      sendResponse({ pages: transcriber.get(message.tabId) } satisfies PagesResponse);
      return false;
    case 'panel:scan':
      activation.isActive(message.tabId).then((active) => {
        if (active) scan(message.tabId);
        sendResponse();
      });
      return true;
  }
  return false;
});
