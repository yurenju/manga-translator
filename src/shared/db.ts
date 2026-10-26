/**
 * 外掛 origin 的 IndexedDB（ADR 0002）。SW、offscreen、side panel 共用，content script 讀不到。
 * 之後的 ticket 加 store（Series、Series Notes、翻譯快取）時，調高 DB_VERSION 並在 upgrade 裡依舊版本建立。
 */
const DB_NAME = 'manga-translator';
const DB_VERSION = 2;

export const STORES = {
  /** 已啟動的 tab：key 是 tabId。 */
  activeTabs: 'activeTabs',
  /** Claude 的 API key（spec #27 第 5 節）：key 是 API_KEY_ID。只有 offscreen 與 side panel 設定區讀值。 */
  apiKeys: 'apiKeys',
} as const;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) db.createObjectStore(STORES.activeTabs);
      if (event.oldVersion < 2) db.createObjectStore(STORES.apiKeys);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
