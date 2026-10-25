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
  /** SW → side panel：某個 tab 的 Page 更新了。 */
  | { type: 'pages:updated'; tabId: number; pages: PageThumb[] }
  /** SW → content script：量畫面上完整可見的 Page 候選。回應 PageCandidatesResponse。 */
  | { type: 'content:findPages' }
  /** SW → offscreen：依候選裁切截圖並做縮圖。回應 CropResponse。 */
  | ({ type: 'offscreen:crop' } & CropRequest)
  /** e2e build 才有：等同點外掛圖示（spec #27 第 12 節）。 */
  | { type: 'test:activate'; tabId: number };

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

export interface CropRequest {
  /** captureVisibleTab 的 data URL。 */
  screenshot: string;
  viewport: Size;
  candidates: PageCandidate[];
}

export interface PageThumb extends PageCandidate {
  /** 裁切後縮小的 data URL。 */
  thumbnail: string;
}

export type CropResponse = { pages: PageThumb[] } | { error: string };

export interface PagesResponse {
  pages: PageThumb[];
}
