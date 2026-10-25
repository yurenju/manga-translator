import type { Message, StatusResponse } from '../shared/messages.ts';
import { createActivation } from './activation.ts';
import { indexedDbTabStore } from './tab-store.ts';

const store = indexedDbTabStore();

// 瀏覽器重開後 tab id 會重新編號，上一次的啟動狀態都不算數。
chrome.runtime.onStartup.addListener(() => {
  void store.clear();
});

const activation = createActivation({
  store,
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
    // side panel 沒開時沒有接收者，sendMessage 會 reject，忽略即可。
    chrome.runtime.sendMessage({ type: 'status:changed', tabId, active } satisfies Message).catch(() => {});
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
});

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  // __E2E__ 是 build 時的常數，正式 build 裡這段會被整段移除。
  if (__E2E__ && message.type === 'test:activate') {
    activation.activate(message.tabId).then(() => sendResponse());
    return true;
  }
  switch (message.type) {
    case 'panel:getStatus':
      activation.isActive(message.tabId).then((active) => sendResponse({ active } satisfies StatusResponse));
      return true;
    case 'panel:stop':
      activation.stop(message.tabId).then(() => sendResponse());
      return true;
  }
  return false;
});
