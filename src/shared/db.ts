/**
 * 外掛 origin 的 IndexedDB（ADR 0002）。SW、offscreen、side panel 共用，content script 讀不到。
 * 之後的 ticket 加 store（Series Notes、API key）時，調高 DB_VERSION 並在 upgrade 裡依舊版本建立。
 */
const DB_NAME = 'manga-translator';
const DB_VERSION = 2;

export const STORES = {
  /** 已啟動的 tab：key 是 tabId。 */
  activeTabs: 'activeTabs',
  /** Series（含 Provisional Series）：keyPath id。 */
  series: 'series',
  /** 翻譯快取 PageTranslation：keyPath [seriesId, pageHash]，index seriesId。 */
  pageTranslations: 'pageTranslations',
} as const;

/** pageTranslations 依 Series 查詢的 index。 */
export const BY_SERIES = 'seriesId';

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) db.createObjectStore(STORES.activeTabs);
      if (event.oldVersion < 2) {
        db.createObjectStore(STORES.series, { keyPath: 'id' });
        db.createObjectStore(STORES.pageTranslations, { keyPath: ['seriesId', 'pageHash'] }).createIndex(BY_SERIES, 'seriesId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
