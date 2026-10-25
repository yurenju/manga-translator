import { describe, expect, it } from 'vitest';
import { createActivation, type ActivationDeps, type TabState } from './activation.ts';

const JUMP = 'https://shonenjumpplus.com/episode/123';

/** 用記憶體模擬 Chrome：tab 的網址、注入紀錄、side panel 紀錄。 */
function fakeChrome(urls: Record<number, string>) {
  const states = new Map<number, TabState>();
  const calls = { openedPanels: [] as number[], injected: [] as number[], stopped: [] as number[] };
  const statusEvents: [number, boolean][] = [];
  const failInjectionFor = new Set<number>();
  const deps: ActivationDeps = {
    store: {
      get: async (tabId) => states.get(tabId),
      set: async (tabId, s) => void states.set(tabId, s),
      delete: async (tabId) => void states.delete(tabId),
    },
    getTabUrl: async (tabId) => urls[tabId],
    openSidePanel: async (tabId) => void calls.openedPanels.push(tabId),
    injectContentScript: async (tabId) => {
      if (failInjectionFor.has(tabId)) throw new Error('Cannot access contents of the page');
      calls.injected.push(tabId);
    },
    stopContentScript: async (tabId) => void calls.stopped.push(tabId),
    onStatusChanged: (tabId, active) => void statusEvents.push([tabId, active]),
  };
  return { deps, calls, statusEvents, failInjectionFor, urls };
}

describe('activate', () => {
  it('啟動後 tab 為已啟動、打開 side panel、注入 content script', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(await activation.isActive(1)).toBe(true);
    expect(chrome.calls.openedPanels).toEqual([1]);
    expect(chrome.calls.injected).toEqual([1]);
  });

  it('在任何 await 之前就同步打開 side panel（否則會失去 user gesture）', () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);

    void activation.activate(1);

    expect(chrome.calls.openedPanels).toEqual([1]);
  });

  it('side panel 打不開（沒有 user gesture，例如測試入口）仍然會啟動', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    chrome.deps.openSidePanel = () =>
      Promise.reject(new Error('sidePanel.open() may only be called in response to a user gesture.'));
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(await activation.isActive(1)).toBe(true);
  });

  it('注入失敗（例如 chrome:// 頁面）時不算啟動', async () => {
    const chrome = fakeChrome({ 1: 'chrome://settings/' });
    chrome.failInjectionFor.add(1);
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(await activation.isActive(1)).toBe(false);
  });

  it('啟動成功會通知狀態改變', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(chrome.statusEvents).toEqual([[1, true]]);
  });
});

describe('stop', () => {
  it('停止後通知 content script 清理，之後重新整理不再注入', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.stop(1);
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(await activation.isActive(1)).toBe(false);
    expect(chrome.calls.stopped).toEqual([1]);
    expect(chrome.calls.injected).toEqual([1]);
    expect(chrome.statusEvents.at(-1)).toEqual([1, false]);
  });
});

describe('tab 生命週期', () => {
  it('同 origin 重新整理載入完成後自動重新注入', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabUpdated(1, { status: 'loading', url: JUMP });
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(chrome.calls.injected).toEqual([1, 1]);
    expect(await activation.isActive(1)).toBe(true);
  });

  it('同 origin 換到另一頁仍維持啟動並重新注入', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.urls[1] = 'https://shonenjumpplus.com/episode/456';
    await activation.handleTabUpdated(1, { status: 'loading', url: chrome.urls[1] });
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(chrome.calls.injected).toEqual([1, 1]);
  });

  it('換 origin 就停止，之後載入完成也不注入', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.urls[1] = 'https://example.com/';
    await activation.handleTabUpdated(1, { status: 'loading', url: chrome.urls[1] });
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(await activation.isActive(1)).toBe(false);
    expect(chrome.calls.injected).toEqual([1]);
    expect(chrome.statusEvents).toEqual([
      [1, true],
      [1, false],
    ]);
  });

  it('沒啟動的 tab 載入完成不注入', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);

    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(chrome.calls.injected).toEqual([]);
  });

  it('重新注入失敗（例如 activeTab 授權已失效）就停止', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.failInjectionFor.add(1);
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(await activation.isActive(1)).toBe(false);
  });

  it('關掉 tab 就清掉狀態', async () => {
    const chrome = fakeChrome({ 1: JUMP });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabRemoved(1);

    expect(await activation.isActive(1)).toBe(false);
  });
});
