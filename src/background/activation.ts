/**
 * 每個 tab 的啟動狀態（ADR 0003、spec #27 第 3.1 節）。
 * Chrome API 都從 deps 注入，SW 的 index.ts 負責接上真的 chrome.*。
 */

export interface TabState {
  /** 啟動當下的 origin；換 origin 就停止。 */
  origin: string;
  /** 這次啟動的 Series；翻譯快取寫在它的 ID 下。 */
  seriesId: string;
}

export interface TabStateStore {
  get(tabId: number): Promise<TabState | undefined>;
  set(tabId: number, state: TabState): Promise<void>;
  delete(tabId: number): Promise<void>;
}

export interface ActivationDeps {
  store: TabStateStore;
  getTabUrl(tabId: number): Promise<string | undefined>;
  openSidePanel(tabId: number): Promise<void>;
  injectContentScript(tabId: number): Promise<void>;
  stopContentScript(tabId: number): Promise<void>;
  onStatusChanged(tabId: number, active: boolean): void;
  /**
   * 新的啟動要用的 Series ID：網址模式預選到的 Series，沒有就建一個 Provisional Series（spec #27 第 4.1 節）。
   */
  seriesForUrl(url: string): Promise<string>;
}

export function createActivation(deps: ActivationDeps) {
  /** 點圖示／快捷鍵／e2e 測試入口都呼叫這一個。 */
  async function activate(tabId: number): Promise<void> {
    // 必須在第一個 await 之前呼叫，否則 Chrome 認為已離開 user gesture。
    // 測試入口沒有 user gesture，這裡一定失敗；side panel 打不開不影響啟動。
    deps.openSidePanel(tabId).catch((e: unknown) => console.warn('sidePanel.open failed', e));
    const url = await deps.getTabUrl(tabId);
    if (url === undefined) return;
    if (!(await tryInject(tabId))) return;
    // 已啟動的 tab 再點一次圖示不算新的啟動，沿用同一個 Series。
    const seriesId = (await deps.store.get(tabId))?.seriesId ?? (await deps.seriesForUrl(url));
    await deps.store.set(tabId, { origin: new URL(url).origin, seriesId });
    deps.onStatusChanged(tabId, true);
  }

  async function isActive(tabId: number): Promise<boolean> {
    return (await deps.store.get(tabId)) !== undefined;
  }

  async function getSeriesId(tabId: number): Promise<string | undefined> {
    return (await deps.store.get(tabId))?.seriesId;
  }

  /** side panel 選了別的 Series（或合併後改用目標）：之後的快取查詢與翻譯都用它。沒啟動就不動。 */
  async function setSeriesId(tabId: number, seriesId: string): Promise<void> {
    const state = await deps.store.get(tabId);
    if (state) await deps.store.set(tabId, { ...state, seriesId });
  }

  async function tryInject(tabId: number): Promise<boolean> {
    try {
      await deps.injectContentScript(tabId);
      return true;
    } catch (e) {
      console.warn('content script injection failed', e);
      return false;
    }
  }

  /** 只清掉啟動狀態；通知 content script 結束是 stop() 的事。 */
  async function markInactive(tabId: number): Promise<void> {
    await deps.store.delete(tabId);
    deps.onStatusChanged(tabId, false);
  }

  /** 對應 chrome.tabs.onUpdated 的 changeInfo。 */
  async function handleTabUpdated(tabId: number, change: { url?: string; status?: string }): Promise<void> {
    const state = await deps.store.get(tabId);
    if (!state) return;
    if (change.url !== undefined && new URL(change.url).origin !== state.origin) {
      await markInactive(tabId);
      return;
    }
    // 重新注入失敗通常是 activeTab 授權已失效，只能等使用者再點一次圖示。
    if (change.status === 'complete' && !(await tryInject(tabId))) await markInactive(tabId);
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    await deps.store.delete(tabId);
  }

  /** side panel 的「停止」。 */
  async function stop(tabId: number): Promise<void> {
    await markInactive(tabId);
    // 頁面可能已經關掉或換頁，content script 不在也沒關係。
    await deps.stopContentScript(tabId).catch(() => {});
  }

  return { activate, stop, isActive, getSeriesId, setSeriesId, handleTabUpdated, handleTabRemoved };
}
