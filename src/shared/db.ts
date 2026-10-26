/**
 * 外掛 origin 的 IndexedDB（ADR 0002）。SW、offscreen、side panel 共用，content script 讀不到。
 * 之後的 ticket 加 store（Series Notes 等）時，調高 DB_VERSION 並在 upgrade 裡依舊版本建立。
 */
const DB_NAME = 'manga-translator';
const DB_VERSION = 4;

export const STORES = {
  /** 已啟動的 tab：key 是 tabId。 */
  activeTabs: 'activeTabs',
  /** Claude 的 API key（spec #27 第 5 節）：key 是 API_KEY_ID。只有 offscreen 與 side panel 設定區讀值。 */
  apiKeys: 'apiKeys',
  /** Series（含 Provisional Series）：keyPath id。 */
  series: 'series',
  /** 翻譯快取 PageTranslation：keyPath [seriesId, pageHash]，index seriesId。 */
  pageTranslations: 'pageTranslations',
  /** 網址模式 UrlPattern：keyPath pattern，index seriesId（#36）。 */
  urlPatterns: 'urlPatterns',
  /** Series Notes 條目 NotesEntry：keyPath [seriesId, 原文]，index seriesId（#36 合併、#37）。 */
  seriesNotes: 'seriesNotes',
  /** 建議修改 NotesSuggestion：自動遞增 key，index seriesId（#36 合併、#37）。 */
  notesSuggestions: 'notesSuggestions',
} as const;

/** pageTranslations、urlPatterns、seriesNotes、notesSuggestions 依 Series 查詢的 index。 */
export const BY_SERIES = 'seriesId';

/** 在一個 store 上開一個 transaction 跑一個 request，transaction 完成時 resolve 它的結果。 */
export function storeRequest<T>(
  db: Promise<IDBDatabase>,
  store: string,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return db.then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = op(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) db.createObjectStore(STORES.activeTabs);
      if (event.oldVersion < 2) db.createObjectStore(STORES.apiKeys);
      if (event.oldVersion < 3) {
        db.createObjectStore(STORES.series, { keyPath: 'id' });
        db.createObjectStore(STORES.pageTranslations, { keyPath: ['seriesId', 'pageHash'] }).createIndex(BY_SERIES, 'seriesId');
      }
      if (event.oldVersion < 4) {
        db.createObjectStore(STORES.urlPatterns, { keyPath: 'pattern' }).createIndex(BY_SERIES, 'seriesId');
        db.createObjectStore(STORES.seriesNotes, { keyPath: ['seriesId', '原文'] }).createIndex(BY_SERIES, 'seriesId');
        db.createObjectStore(STORES.notesSuggestions, { autoIncrement: true }).createIndex(BY_SERIES, 'seriesId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
