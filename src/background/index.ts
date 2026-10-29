import { CLAUDE_MODEL, PROMPT_VERSION } from '../offscreen/claude-translator.ts';
import { indexedDbApiKeyStore } from '../shared/api-key-store.ts';
import { hasDataConsent } from '../shared/data-consent.ts';
import { FAKE_VERSION } from '../shared/fake-translator.ts';
import type {
  AnalyzeResponse,
  AutoTranslateResponse,
  CaptureFinishedResponse,
  CropResponse,
  FakeTranslatorConfig,
  ImportResponse,
  Message,
  ModelStatus,
  ModelStatusResponse,
  NotesResponse,
  PageCandidatesResponse,
  PagesResponse,
  PipelineConfig,
  SeriesResponse,
  StatusResponse,
  TestConfig,
  TestConnectionResponse,
  TranslateResponse,
  ProposeNotesResponse,
} from '../shared/messages.ts';
import { acceptSuggestion, editEntry, ignoreSuggestion, pendingSuggestions, type SeriesNotes, type TranslatorVersion } from '../shared/series-notes.ts';
import { createTrace } from '../shared/trace.ts';
import type { NotesInput, TranslateInput, Translator } from '../shared/translator.ts';
import { createActivation } from './activation.ts';
import { BACKUP_KEYS, createBackup } from './backup.ts';
import { indexedDbPageCache } from './cache-store.ts';
import { ensureOffscreenDocument } from './offscreen.ts';
import { createOverlaySync } from './overlay-sync.ts';
import { createScanner } from './scan.ts';
import { createSeriesCatalog } from './series-catalog.ts';
import { indexedDbBackupRepo, indexedDbNotesStore, indexedDbSeriesRepo } from './series-store.ts';
import { indexedDbTabStore } from './tab-store.ts';
import { createTranscriber } from './transcribe.ts';

declare global {
  /** e2e build 才有：每次 captureVisibleTab 開始的時間，給測試數截了幾次、等截圖停下來。 */
  var __captureLog: number[] | undefined;
  /** e2e build 才有：最近 3 張截好的圖（data URL）與開始截的時間，給測試確認截圖裡沒有覆蓋層。 */
  var __captures: { startedAt: number; screenshot: string }[] | undefined;
  /** e2e build 才有：在建立任何 Page 之前呼叫（browser/fixtures.ts）。 */
  var __configureForTest: ((config: TestConfig) => void) | undefined;
  /** e2e build 才有：FakeTranslator 被呼叫的次數（確認命中快取時沒有翻譯）。 */
  var __translateCalls: number | undefined;
  /** e2e build 才有：每次送給 FakeTranslator 的內容（#37：確認前一頁新增的條目有送出）。 */
  var __translateInputs: TranslateInput[] | undefined;
  /** e2e build 才有：每次送給 FakeTranslator 整理 Notes（②）的內容。 */
  var __notesInputs: NotesInput[] | undefined;
  /** e2e build 才有：記下過幾個 Page「帶覆蓋層的樣子」（scan.ts），給測試等它做完。 */
  var __overlaidRecords: number | undefined;
}

const trace = createTrace('sw');
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
  async prepareCapture(tabId, hideOverlay) {
    await chrome.tabs.sendMessage(tabId, { type: 'content:prepareCapture', hideOverlay } satisfies Message);
  },
  finishCapture: (tabId) => chrome.tabs.sendMessage<Message, CaptureFinishedResponse>(tabId, { type: 'content:finishCapture' }),
  async captureWindow(windowId) {
    if (__E2E__) (globalThis.__captureLog ??= []).push(Date.now());
    const startedAt = Date.now();
    const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (__E2E__) globalThis.__captures = [...(globalThis.__captures ?? []), { startedAt, screenshot }].slice(-3);
    trace('capture', { windowId, ms: Date.now() - startedAt, screenshot });
    return screenshot;
  },
  async crop(request) {
    await ensureOffscreenDocument();
    const startedAt = Date.now();
    const response = await chrome.runtime.sendMessage<Message, CropResponse>({ type: 'offscreen:crop', ...request });
    if ('error' in response) throw new Error(`crop failed: ${response.error}`);
    trace('crop', { ms: Date.now() - startedAt, pages: response.pages });
    return response.pages;
  },
  publish(tabId, pages, capture) {
    // 沒有 capture＝畫面上沒有完整可見的 Page（或停止）；停止時的清理在 onStatusChanged
    // 先讓 overlaySync 知道哪些覆蓋已經不在了（換 src），transcriber 接著 publish 時才會重送
    overlaySync.captured(tabId, pages);
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
    if (__E2E__ && fakeTranslator) {
      globalThis.__translateCalls = (globalThis.__translateCalls ?? 0) + 1;
      (globalThis.__translateInputs ??= []).push(input);
    }
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, TranslateResponse>({
      type: 'offscreen:translate',
      input,
      ...(__E2E__ && fakeTranslator ? { fake: fakeTranslator } : {}),
    });
    if ('error' in response) throw new Error(response.error);
    return response.output;
  },
  async proposeNotes(input) {
    if (__E2E__ && fakeTranslator) (globalThis.__notesInputs ??= []).push(input);
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, ProposeNotesResponse>({
      type: 'offscreen:proposeNotes',
      input,
      ...(__E2E__ && fakeTranslator ? { fake: fakeTranslator } : {}),
    });
    if ('error' in response) throw new Error(response.error);
    return response.output;
  },
};

/**
 * 沒有 key（spec 第 5 節）或還沒同意資料使用（shared/data-consent.ts）時不排 LLM 工作。
 * 翻譯與 Series Notes 都從這裡拿 Translator，所以送到 Anthropic 的呼叫都會先過這道檢查。
 */
async function getTranslator(): Promise<Translator | undefined> {
  if (__E2E__ && fakeTranslator && !requireApiKey) return offscreenTranslator;
  return (await apiKeys.has()) && (await hasDataConsent()) ? offscreenTranslator : undefined;
}

/** 目前會用來翻譯的模型與 prompt 版本（過時提示比對用）；沒有 key 時不比。 */
async function translatorVersion(): Promise<TranslatorVersion | undefined> {
  if (!(await getTranslator())) return undefined;
  return __E2E__ && fakeTranslator ? FAKE_VERSION : { model: CLAUDE_MODEL, promptVersion: PROMPT_VERSION };
}

const notesStore = indexedDbNotesStore();

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
  translatorVersion,
  getSeriesId: (tabId) => activation.getSeriesId(tabId),
  cache: indexedDbPageCache(),
  notes: {
    ...notesStore,
    // 背景整理 Notes（②）套用了 notes_changes 或人改了：side panel 的 Series Notes 區塊重新讀
    async save(seriesId, notes) {
      await notesStore.save(seriesId, notes);
      notifyPanel({ type: 'notes:changed', seriesId });
    },
  },
  publish(tabId, pages) {
    notifyPanel({ type: 'pages:updated', tabId, pages });
    overlaySync.publish(tabId, pages);
  },
  onJobEvent(event) {
    trace('job', { ...event });
  },
});

const overlaySync = createOverlaySync({
  show({ tabId, anchorId, pageHash, subRect, text }) {
    const message: Message = { type: 'content:showOverlay', anchorId, pageHash, subRect, text };
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  },
});

let modelStatus: ModelStatus = { state: 'idle' };

if (__E2E__) {
  globalThis.__configureForTest = (config) => {
    pipelineConfig = config.pipeline;
    globalThis.__translateCalls = 0;
    globalThis.__translateInputs = [];
    globalThis.__notesInputs = [];
    fakeTranslator = config.fakeTranslator ? { unreadableTexts: config.unreadableTexts ?? [], notes: config.fakeNotes ?? [] } : undefined;
    requireApiKey = config.requireApiKey ?? false;
  };
}

/** 頁面可能剛好換頁、content script 不在，或截圖失敗；這次掃描就放棄，等下一次觸發。 */
function scan(tabId: number): void {
  trace('scan', { tabId });
  scanner.scan(tabId).catch((e: unknown) => console.warn('scan failed', e));
}

const backupRepo = indexedDbBackupRepo();
const backup = createBackup({ repo: backupRepo, updateNotes: (seriesId, change) => transcriber.updateNotes(seriesId, change), now: () => Date.now() });

async function notesResponse(tabId: number): Promise<NotesResponse> {
  const seriesId = await activation.getSeriesId(tabId);
  if (seriesId === undefined) return { seriesId, entries: [], suggestions: [] };
  const notes = await notesStore.load(seriesId);
  return { seriesId, entries: notes.entries, suggestions: pendingSuggestions(notes) };
}

/** side panel 改這個 tab 目前 Series 的 Notes（#38）。沒啟動就不動。action＋detail 記進 trace（#40 驗收）。 */
async function changeNotes(tabId: number, action: string, detail: Record<string, unknown>, change: (notes: SeriesNotes) => SeriesNotes): Promise<void> {
  const seriesId = await activation.getSeriesId(tabId);
  if (seriesId === undefined) return;
  await transcriber.updateNotes(seriesId, change);
  trace(action, { tabId, seriesId, ...detail });
}

const seriesCatalog = createSeriesCatalog({ repo: indexedDbSeriesRepo(), now: () => new Date(), newId: () => crypto.randomUUID() });

async function seriesResponse(tabId: number): Promise<SeriesResponse> {
  const [current, options] = await Promise.all([activation.getSeriesId(tabId), seriesCatalog.menu()]);
  return { current, options };
}

/** 這個 tab 的 Series 操作（#36）共用的部分：算出新的 Series ID、記下來、通知 panel。回傳新的 ID；沒變（或沒啟動）是 undefined。 */
async function applySeriesChange(
  tabId: number,
  action: string,
  change: (url: string, current: string) => Promise<string>,
): Promise<string | undefined> {
  const [url, current] = await Promise.all([chrome.tabs.get(tabId).then((t) => t.url), activation.getSeriesId(tabId)]);
  if (url === undefined || current === undefined) return undefined;
  const next = await change(url, current);
  // 記住了哪個網址模式記在 series:remember，合併搬了什麼記在 series:merge
  trace(action, { tabId, from: current, seriesId: next });
  await activation.setSeriesId(tabId, next);
  notifyPanel({ type: 'series:changed', tabId });
  return next === current ? undefined : next;
}

/**
 * 選一部（或新增）Series：換成另一個 ID 就重新擷取，快取查詢與翻譯改用新的 ID。
 * #34 的 transcriber 以 pageHash 記住看過的 Page；不先忘掉的話重新擷取會沿用舊 ID 的結果。
 */
async function switchSeries(tabId: number, action: string, choose: (url: string) => Promise<string>): Promise<void> {
  if ((await applySeriesChange(tabId, action, choose)) === undefined) return;
  transcriber.resetPages(tabId);
  scan(tabId);
}

/** 改名（ID 不變）或合併（快取已改到目標 ID、不自動重翻）：不重新擷取，畫面上的 Page 改記在新的 ID 下。 */
async function updateSeries(tabId: number, action: string, change: (url: string, current: string) => Promise<string>): Promise<void> {
  const next = await applySeriesChange(tabId, action, change);
  if (next !== undefined) transcriber.reassignSeries(tabId, next);
}

const activation = createActivation({
  store,
  seriesForUrl: (url) => seriesCatalog.seriesForUrl(url),
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
    trace('status', { tabId, active });
    notifyPanel({ type: 'status:changed', tabId, active });
    if (active) scan(tabId);
    else {
      scanner.clear(tabId);
      transcriber.clear(tabId);
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
    case 'content:pageTurn': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined)
        void activation.isActive(tabId).then((active) => {
          if (active) scan(tabId);
        });
      return false;
    }
    case 'content:overlayShown': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined)
        void activation.isActive(tabId).then((active) => {
          if (active) scanner.recordOverlaid(tabId).catch((e: unknown) => console.warn('record overlaid failed', e));
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
      void transcriber.translate(message.tabId, message.pageHash).finally(() => sendResponse());
      return true;
    case 'panel:getNotes':
      notesResponse(message.tabId).then(sendResponse);
      return true;
    case 'panel:editNote': {
      const { 原文, fields } = message;
      changeNotes(message.tabId, 'panel:editNote', { 原文, fields }, (notes) => ({ ...notes, entries: editEntry(notes.entries, 原文, fields) })).then(() =>
        sendResponse(),
      );
      return true;
    }
    case 'panel:acceptSuggestion':
    case 'panel:ignoreSuggestion': {
      const { suggestion } = message;
      const apply = message.type === 'panel:acceptSuggestion' ? acceptSuggestion : ignoreSuggestion;
      const { 原文, 建議譯文 } = suggestion;
      changeNotes(message.tabId, message.type, { 原文, 建議譯文 }, (notes) => apply(notes, suggestion)).then(() => sendResponse());
      return true;
    }
    case 'panel:clearCache':
      // 畫面上已經顯示的頁不動；之後翻回來就重新翻譯
      activation
        .getSeriesId(message.tabId)
        .then(async (seriesId) => {
          if (seriesId === undefined) return;
          await backupRepo.clearTranslations(seriesId);
          trace('panel:clearCache', { tabId: message.tabId, seriesId });
        })
        .then(() => sendResponse());
      return true;
    case 'panel:export':
      backup
        .exportAll()
        .then((file) => {
          // 筆數就夠核對；檔案內容（含真實頁面的原文、譯文）不進 trace
          const counts = Object.fromEntries(BACKUP_KEYS.map((k) => [k, file[k].length]));
          trace('panel:export', { format: file.format, counts, hasApiKeyPrefix: JSON.stringify(file).includes('sk-ant-') });
          return file;
        })
        .then(sendResponse);
      return true;
    case 'panel:import':
      backup
        .importAll(message.data)
        .then((seriesIds): ImportResponse => {
          for (const seriesId of seriesIds) notifyPanel({ type: 'notes:changed', seriesId });
          trace('panel:import', { ok: true, notesSeriesIds: seriesIds });
          return { ok: true };
        })
        .catch((e: unknown): ImportResponse => {
          trace('panel:import', { ok: false, error: e });
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        })
        .then(sendResponse);
      return true;
    case 'panel:testConnection':
      ensureOffscreenDocument()
        .then(() => chrome.runtime.sendMessage<Message, TestConnectionResponse>({ type: 'offscreen:testConnection' }))
        .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) satisfies TestConnectionResponse)
        .then(sendResponse);
      return true;
    case 'panel:getSeries':
      seriesResponse(message.tabId).then(sendResponse);
      return true;
    case 'panel:selectSeries': {
      const { seriesId } = message;
      switchSeries(message.tabId, 'panel:selectSeries', (url) => seriesCatalog.select(seriesId, url).then(() => seriesId)).then(() => sendResponse());
      return true;
    }
    case 'panel:createSeries': {
      const { name } = message;
      switchSeries(message.tabId, 'panel:createSeries', async (url) => (await seriesCatalog.create(name, url)).id).then(() => sendResponse());
      return true;
    }
    case 'panel:renameSeries': {
      const { name } = message;
      updateSeries(message.tabId, 'panel:renameSeries', (url, current) => seriesCatalog.rename(current, name, url).then(() => current)).then(() =>
        sendResponse(),
      );
      return true;
    }
    case 'panel:mergeSeries': {
      const { targetId } = message;
      // 來源不是 Provisional Series（或目標不在）時 merge 不動，這個 tab 留在原本的 Series
      updateSeries(message.tabId, 'panel:mergeSeries', async (url, current) => ((await seriesCatalog.merge(current, targetId, url)) ? targetId : current)).then(
        () => sendResponse(),
      );
      return true;
    }
    case 'panel:scan':
      activation.isActive(message.tabId).then((active) => {
        if (active) scan(message.tabId);
        sendResponse();
      });
      return true;
  }
  return false;
});
