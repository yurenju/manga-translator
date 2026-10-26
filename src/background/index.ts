import { indexedDbApiKeyStore } from '../shared/api-key-store.ts';
import type {
  AnalyzeResponse,
  AutoTranslateResponse,
  CropResponse,
  FakeTranslatorConfig,
  Message,
  ModelStatus,
  ModelStatusResponse,
  OverlayResponse,
  PageCandidatesResponse,
  PagesResponse,
  PipelineConfig,
  StatusResponse,
  TestConfig,
  TestConnectionResponse,
  TranslateResponse,
} from '../shared/messages.ts';
import type { Translator } from '../shared/translator.ts';
import { createActivation } from './activation.ts';
import { indexedDbPageCache, indexedDbSeriesStore } from './cache-store.ts';
import { ensureOffscreenDocument } from './offscreen.ts';
import { createOverlaySync } from './overlay-sync.ts';
import { createScanner } from './scan.ts';
import { provisionalSeries } from './series.ts';
import { indexedDbTabStore } from './tab-store.ts';
import { createTranscriber, type JobEvent } from './transcribe.ts';

declare global {
  /** e2e build 才有：每次 captureVisibleTab 的時間，給測試檢查限速。 */
  var __captureLog: number[] | undefined;
  /** e2e build 才有：最近 3 張截圖（data URL），給測試確認截圖裡沒有覆蓋層。 */
  var __captures: string[] | undefined;
  /** e2e build 才有：在建立任何 Page 之前呼叫（e2e/fixtures.ts）。 */
  var __configureForTest: ((config: TestConfig) => void) | undefined;
  /** e2e build 才有：FakeTranslator 被呼叫的次數（確認命中快取時沒有翻譯）。 */
  var __translateCalls: number | undefined;
  /** e2e build 才有：翻譯佇列的事件（#34），給測試確認後進先出與丟棄。 */
  var __jobLog: { tabId: number; event: JobEvent; pageHash: string; at: number }[] | undefined;
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
  async hideOverlay(tabId) {
    await chrome.tabs.sendMessage(tabId, { type: 'content:hideOverlay' } satisfies Message);
  },
  async restoreOverlay(tabId) {
    await chrome.tabs.sendMessage(tabId, { type: 'content:restoreOverlay' } satisfies Message);
  },
  async captureWindow(windowId) {
    if (__E2E__) (globalThis.__captureLog ??= []).push(Date.now());
    const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (__E2E__) globalThis.__captures = [...(globalThis.__captures ?? []), screenshot].slice(-3);
    return screenshot;
  },
  async crop(request) {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, CropResponse>({ type: 'offscreen:crop', ...request });
    if ('error' in response) throw new Error(`crop failed: ${response.error}`);
    return response.pages;
  },
  publish(tabId, pages, capture) {
    // 沒有 capture＝畫面上沒有完整可見的 Page（或停止）；停止時的清理在 onStatusChanged
    void transcriber.update(tabId, pages, capture);
  },
});

/** e2e build 才會改（test:configure）。 */
let pipelineConfig: PipelineConfig = {};
/** e2e build 才會設：offscreen 用 FakeTranslator 取代 Claude。 */
let fakeTranslator: FakeTranslatorConfig | undefined;
/** e2e build：false＝FakeTranslator 不需要 API key（#30 起的 e2e 預設）。 */
let requireApiKey = true;

const apiKeys = indexedDbApiKeyStore();

/** SW 不讀 key：翻譯在 offscreen document 裡做，offscreen 自己從 IndexedDB 讀 key（spec #27 第 5 節）。 */
const offscreenTranslator: Translator = {
  async translatePage(input) {
    // e2e：FakeTranslator 在 offscreen，這裡記呼叫次數（確認命中快取時沒有翻譯，#33）
    if (__E2E__ && fakeTranslator) globalThis.__translateCalls = (globalThis.__translateCalls ?? 0) + 1;
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, TranslateResponse>({
      type: 'offscreen:translate',
      input,
      ...(__E2E__ && fakeTranslator ? { fake: fakeTranslator } : {}),
    });
    if ('error' in response) throw new Error(response.error);
    return response.output;
  },
};

/** 沒有 key 時不排 LLM 工作（spec 第 5 節）。 */
async function getTranslator(): Promise<Translator | undefined> {
  if (__E2E__ && fakeTranslator && !requireApiKey) return offscreenTranslator;
  return (await apiKeys.has()) ? offscreenTranslator : undefined;
}

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
  getTranslator,
  getSeriesId: (tabId) => activation.getSeriesId(tabId),
  cache: indexedDbPageCache(),
  publish(tabId, pages) {
    notifyPanel({ type: 'pages:updated', tabId, pages });
    overlaySync.publish(tabId, pages);
  },
  onJobEvent(tabId, event, pageHash) {
    if (__E2E__) (globalThis.__jobLog ??= []).push({ tabId, event, pageHash, at: Date.now() });
  },
});

/** side panel 的覆蓋開關（每個 tab；預設開，停止後回到預設）。 */
const overlayEnabled = new Map<number, boolean>();

const overlaySync = createOverlaySync({
  show(tabId, anchorId, text) {
    const message: Message = { type: 'content:showOverlay', anchorId, text, enabled: overlayEnabled.get(tabId) ?? true };
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  },
});

let modelStatus: ModelStatus = { state: 'idle' };

if (__E2E__) {
  globalThis.__configureForTest = (config) => {
    pipelineConfig = config.pipeline;
    globalThis.__translateCalls = 0;
    globalThis.__jobLog = [];
    fakeTranslator = config.fakeTranslator ? { unreadableTexts: config.unreadableTexts ?? [] } : undefined;
    requireApiKey = config.requireApiKey ?? false;
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
    else {
      scanner.clear(tabId);
      transcriber.clear(tabId);
      overlayEnabled.delete(tabId);
    }
  },
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void activation.activate(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'activate' && tab?.id !== undefined) void activation.activate(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 重新整理或換頁：anchor 都換了，重新查快取（同 origin 會重新注入、繼續啟動）
  if (changeInfo.status === 'loading') transcriber.resetPages(tabId);
  void activation.handleTabUpdated(tabId, changeInfo);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void activation.handleTabRemoved(tabId);
  scanner.clear(tabId);
  transcriber.clear(tabId);
});

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
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
    case 'panel:getOverlay':
      sendResponse({ enabled: overlayEnabled.get(message.tabId) ?? true } satisfies OverlayResponse);
      return false;
    case 'panel:setOverlay':
      overlayEnabled.set(message.tabId, message.enabled);
      chrome.tabs.sendMessage(message.tabId, { type: 'content:setOverlayEnabled', enabled: message.enabled } satisfies Message).catch(() => {});
      sendResponse();
      return false;
    case 'content:pageTurn': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined)
        void activation.isActive(tabId).then((active) => {
          if (active) scan(tabId);
        });
      return false;
    }
    case 'panel:getAutoTranslate':
      sendResponse({ enabled: transcriber.isAutoTranslate(message.tabId) } satisfies AutoTranslateResponse);
      return false;
    case 'panel:setAutoTranslate':
      void transcriber.setAutoTranslate(message.tabId, message.enabled);
      sendResponse();
      return false;
    case 'panel:getPages':
      sendResponse({ pages: transcriber.get(message.tabId) } satisfies PagesResponse);
      return false;
    case 'panel:translate':
      void transcriber.translate(message.tabId).finally(() => sendResponse());
      return true;
    case 'panel:testConnection':
      ensureOffscreenDocument()
        .then(() => chrome.runtime.sendMessage<Message, TestConnectionResponse>({ type: 'offscreen:testConnection' }))
        .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) satisfies TestConnectionResponse)
        .then(sendResponse);
      return true;
    case 'panel:scan':
      activation.isActive(message.tabId).then((active) => {
        if (active) scan(message.tabId);
        sendResponse();
      });
      return true;
  }
  return false;
});
