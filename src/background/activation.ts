/**
 * 每個 tab 的啟動狀態（ADR 0003、spec #27 第 3.1 節）。
 * Chrome API 都從 deps 注入，SW 的 index.ts 負責接上真的 chrome.*。
 */

export interface TabState {
  /** 啟動當下的 origin；換 origin 就停止。 */
  origin: string;
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
}

export function createActivation(deps: ActivationDeps) {
  /** 點圖示／快捷鍵／e2e 測試入口都呼叫這一個。 */
  async function activate(tabId: number): Promise<void> {
    // 必須在第一個 await 之前呼叫，否則 Chrome 認為已離開 user gesture。
    // 測試入口沒有 user gesture，這裡一定失敗；side panel 打不開不影響啟動。
    deps.openSidePanel(tabId).catch((e: unknown) => console.warn('sidePanel.open failed', e));
    const url = await deps.getTabUrl(tabId);
    if (url === undefined) return;
    try {
      await deps.injectContentScript(tabId);
    } catch (e) {
      console.warn('content script injection failed', e);
      return;
    }
    await deps.store.set(tabId, { origin: new URL(url).origin });
    deps.onStatusChanged(tabId, true);
  }

  async function isActive(tabId: number): Promise<boolean> {
    return (await deps.store.get(tabId)) !== undefined;
  }

  async function deactivate(tabId: number): Promise<void> {
    await deps.store.delete(tabId);
    deps.onStatusChanged(tabId, false);
  }

  /** 對應 chrome.tabs.onUpdated 的 changeInfo。 */
  async function handleTabUpdated(tabId: number, change: { url?: string; status?: string }): Promise<void> {
    const state = await deps.store.get(tabId);
    if (!state) return;
    if (change.url !== undefined && new URL(change.url).origin !== state.origin) {
      await deactivate(tabId);
      return;
    }
    if (change.status === 'complete') {
      try {
        await deps.injectContentScript(tabId);
      } catch (e) {
        console.warn('content script re-injection failed', e);
        await deactivate(tabId);
      }
    }
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    await deps.store.delete(tabId);
  }

  /** side panel 的「停止」。 */
  async function stop(tabId: number): Promise<void> {
    await deactivate(tabId);
    // 頁面可能已經關掉或換頁，content script 不在也沒關係。
    await deps.stopContentScript(tabId).catch(() => {});
  }

  return { activate, stop, isActive, handleTabUpdated, handleTabRemoved };
}
