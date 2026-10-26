import type { PageText } from './page-text.ts';

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
  /** e2e build 才有：等同點外掛圖示（spec #27 第 12 節）。 */
  | { type: 'test:activate'; tabId: number };

/** e2e build 才有（SW 的 globalThis.__configureForTest）：模型下載來源、強制 wasm、改用 FakeTranslator。 */
export interface TestConfig {
  pipeline: PipelineConfig;
  fakeTranslator: boolean;
}

export interface StatusResponse {
  active: boolean;
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

/** side panel 顯示的一個 Page：縮圖＋逐字稿的狀態。 */
export interface PageView extends PageThumb {
  transcript:
    | { state: 'analyzing' }
    /** translated=false：沒有 Translator（沒有 API key），讀音是 kuromoji、沒有譯文。 */
    | { state: 'done'; text: PageText; translated: boolean; translation?: TranslationStatus }
    | { state: 'error'; message: string };
}

/** side panel 狀態列：「已翻譯」或「快取」、模型、秒數、費用（spec #27 第 8 節）。快取時是當初翻譯的數字。 */
export interface TranslationStatus {
  source: 'translated' | 'cache';
  model: string;
  latencyMs: number;
  costUsd: number;
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
