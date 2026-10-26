import type { PageText, RatioRect } from './page-text.ts';
import type { SeriesOption } from './series.ts';
import type { TranslateInput, TranslateOutput } from './translator.ts';

/** onnxruntime-web 的執行環境。 */
export type ExecutionProvider = 'webgpu' | 'wasm';

/** 各 context 之間的 chrome.runtime / chrome.tabs 訊息。 */
export type Message =
  /** side panel → SW：這個 tab 啟動了沒？回應 StatusResponse。 */
  | { type: 'panel:getStatus'; tabId: number }
  /** side panel → SW：停止這個 tab。 */
  | { type: 'panel:stop'; tabId: number }
  /** SW → side panel：某個 tab 的啟動狀態改變了。 */
  | { type: 'status:changed'; tabId: number; active: boolean }
  /** SW → content script：清理並結束。 */
  | { type: 'content:stop' }
  /** side panel → SW：重新找 Page 並截圖。 */
  | { type: 'panel:scan'; tabId: number }
  /** side panel → SW：目前這個 tab 的 Page。回應 PagesResponse。 */
  | { type: 'panel:getPages'; tabId: number }
  /** SW → side panel：某個 tab 的 Page（縮圖＋逐字稿）更新了。 */
  | { type: 'pages:updated'; tabId: number; pages: PageView[] }
  /** SW → content script：量畫面上完整可見的 Page 候選。回應 PageCandidatesResponse。 */
  | { type: 'content:findPageCandidates' }
  /** SW → offscreen：依候選裁切截圖並做縮圖。回應 CropResponse。 */
  | ({ type: 'offscreen:crop' } & CropRequest)
  /** SW → offscreen：對一個 Page 跑本機流水線（偵測＋OCR＋閱讀順序＋kuromoji 讀音）。回應 AnalyzeResponse。 */
  | ({ type: 'offscreen:analyze' } & AnalyzeRequest)
  /** offscreen → 全部：模型下載／載入狀態。 */
  | { type: 'models:status'; status: ModelStatus }
  /** side panel → SW：目前的模型狀態。回應 ModelStatusResponse。 */
  | { type: 'panel:getModelStatus' }
  /** side panel → SW：「翻譯此頁／重新翻譯」：用已經辨識好的原文重新呼叫 Translator。 */
  | { type: 'panel:translate'; tabId: number }
  /**
   * SW → offscreen：翻譯一個 Page。回應 TranslateResponse。
   * API key 不在訊息裡：offscreen 自己從 IndexedDB 讀（spec 第 5 節：key 永遠不經過 messaging）。
   */
  | { type: 'offscreen:translate'; input: TranslateInput; fake?: FakeTranslatorConfig }
  /** side panel → SW → offscreen：「測試連線」。回應 TestConnectionResponse。 */
  | { type: 'panel:testConnection' }
  | { type: 'offscreen:testConnection' }
  /**
   * SW → content script：把一個 Page 的譯文原地覆蓋在 anchor 上（#32）。sub＝Page 在 anchor 裡的範圍
   * （沒給＝整個 anchor；Spread 在 #35）。enabled＝side panel 的覆蓋開關。
   */
  | { type: 'content:showOverlay'; anchorId: string; sub?: RatioRect; text: PageText; enabled: boolean }
  /** SW → content script：截圖前隱藏覆蓋層，等兩個 rAF（已重繪）才回應。 */
  | { type: 'content:hideOverlay' }
  /** SW → content script：截完還原覆蓋層。 */
  | { type: 'content:restoreOverlay' }
  /** SW → content script：side panel 的覆蓋開關。 */
  | { type: 'content:setOverlayEnabled'; enabled: boolean }
  /** side panel → SW：覆蓋開關。 */
  | { type: 'panel:setOverlay'; tabId: number; enabled: boolean }
  /** side panel → SW：覆蓋開關目前的狀態。回應 OverlayResponse。 */
  | { type: 'panel:getOverlay'; tabId: number }
  /** side panel → SW：Series 下拉選單與這個 tab 目前的 Series。回應 SeriesResponse。 */
  | { type: 'panel:getSeries'; tabId: number }
  /** side panel → SW：選了一部 Series（非 Provisional 才記住網址模式）；之後的快取查詢與翻譯改用它。 */
  | { type: 'panel:selectSeries'; tabId: number; seriesId: string }
  /** side panel → SW：「新增 Series…」並選它。 */
  | { type: 'panel:createSeries'; tabId: number; name: string }
  /** side panel → SW：目前的 Series 改名（Provisional 改名＝歸類，ID 不變）。 */
  | { type: 'panel:renameSeries'; tabId: number; name: string }
  /** side panel → SW：目前的 Provisional Series 合併進 targetId；不自動重翻。 */
  | { type: 'panel:mergeSeries'; tabId: number; targetId: string }
  /** SW → side panel：這個 tab 的 Series 或 Series 清單變了，重新 panel:getSeries。 */
  | { type: 'series:changed'; tabId: number }
  /** e2e build 才有：等同點外掛圖示（spec #27 第 12 節）。 */
  | { type: 'test:activate'; tabId: number };

/** e2e build 才有（SW 的 globalThis.__configureForTest）：模型下載來源、強制 wasm、改用 FakeTranslator。 */
export interface TestConfig {
  pipeline: PipelineConfig;
  fakeTranslator: boolean;
  /**
   * true：跟正式 build 一樣，要先在設定區存 API key 才會翻譯（FakeTranslator 取代的只是 Claude）。
   * 預設 false：FakeTranslator 不需要 key（#30 起的 e2e 都這樣用）。
   */
  requireApiKey?: boolean;
  /** FakeTranslator 把這些 ground truth 原文當成無法辨識（模擬 Claude 回 unreadable）。 */
  unreadableTexts?: string[];
}

/** e2e build 才有：offscreen 用 FakeTranslator 取代 Claude。 */
export interface FakeTranslatorConfig {
  unreadableTexts: string[];
}

export type TranslateResponse = { output: TranslateOutput } | { error: string; noApiKey?: true };

export type TestConnectionResponse = { ok: true; model: string } | { ok: false; error: string };

export interface StatusResponse {
  active: boolean;
}

export interface SeriesResponse {
  /** 這個 tab 目前的 Series；沒啟動是 undefined。 */
  current: string | undefined;
  /** 已排好：最近用過的在最上面。 */
  options: SeriesOption[];
}

export interface OverlayResponse {
  enabled: boolean;
}

/** 畫面座標（CSS px，相對 viewport 左上角）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 一個 Page 候選。anchorId 對應 content script 記在記憶體裡的元素（anchor）。 */
export interface PageCandidate {
  anchorId: string;
  rect: Rect;
}

export interface PageCandidatesResponse {
  /** 量 rect 當下的 viewport（CSS px），裁切時用來換算截圖倍率。 */
  viewport: Size;
  candidates: PageCandidate[];
}

export interface CropRequest extends PageCandidatesResponse {
  /** captureVisibleTab 的 data URL。 */
  screenshot: string;
}

export interface PageThumb extends PageCandidate {
  /** 裁切後縮小的 data URL。 */
  thumbnail: string;
  /** Page 的身分（shared/page-hash.ts），從全解析度的裁切算出來；翻譯快取的 key。 */
  pageHash: string;
}

export type CropResponse = { pages: PageThumb[] } | { error: string };

/**
 * 狀態列顯示的翻譯資訊（spec #27 第 8 節）：「已翻譯」或「快取」・模型・秒數・費用。
 * 快取（#33）時是當初翻譯的模型與數字。
 */
export type TranslationInfo = Pick<TranslateOutput, 'model' | 'latencyMs' | 'usage'> & { source: 'translated' | 'cache' };

/** side panel 顯示的一個 Page：縮圖＋逐字稿的狀態。 */
export interface PageView extends PageThumb {
  transcript:
    | { state: 'analyzing' }
    /**
     * translated=false：沒有 Translator（沒有 API key）或翻譯失敗（translateError），讀音是 kuromoji、沒有譯文。
     * translating：按了「翻譯此頁」，正在等 Translator；text 仍是上一份。
     */
    | {
        state: 'done';
        text: PageText;
        translated: boolean;
        translating?: boolean;
        translation?: TranslationInfo;
        translateError?: string;
      }
    | { state: 'error'; message: string };
}

export interface PagesResponse {
  pages: PageView[];
}

/** 只有 e2e 會設定；正式 build 一律從 Hugging Face 下載、自動選 WebGPU／wasm。 */
export interface PipelineConfig {
  /** 取代 https://huggingface.co 的下載來源（mock site）。 */
  modelBaseUrl?: string;
  executionProvider?: ExecutionProvider;
  /** wasm 執行緒上限；e2e 平行跑好幾個瀏覽器時避免互搶 CPU。 */
  maxThreads?: number;
}

export interface AnalyzeRequest {
  screenshot: string;
  viewport: Size;
  candidate: PageCandidate;
  /** e2e build 才會帶。 */
  pipeline?: PipelineConfig;
}

export type AnalyzeResponse = { text: PageText } | { error: string };

export type ModelStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'downloading'; loaded: number; total: number }
  | { state: 'ready'; executionProvider: ExecutionProvider; threads: number }
  | { state: 'error'; message: string };

export interface ModelStatusResponse {
  status: ModelStatus;
}
