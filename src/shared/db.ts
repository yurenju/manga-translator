/**
 * 外掛 origin 的 IndexedDB（ADR 0002）。SW、offscreen、side panel 共用，content script 讀不到。
 * 之後的 ticket 加 store（Series、Series Notes、翻譯快取、API key）時，調高 DB_VERSION 並在 upgrade 裡建立。
 */
const DB_NAME = 'manga-translator';
const DB_VERSION = 1;

export const STORES = {
  /** 已啟動的 tab：key 是 tabId。 */
  activeTabs: 'activeTabs',
} as const;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORES.activeTabs);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
