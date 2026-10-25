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
  /** e2e build 才有：等同點外掛圖示（spec #27 第 12 節）。 */
  | { type: 'test:activate'; tabId: number };

export interface StatusResponse {
  active: boolean;
}
