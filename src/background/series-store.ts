import { BY_SERIES, openDb, STORES, storeRequest } from '../shared/db.ts';
import type { PageTranslation } from '../shared/page-text.ts';
import type { NotesSuggestion } from '../shared/series-notes.ts';
import type { Series, UrlPattern } from '../shared/series.ts';
import type { NotesEntry } from '../shared/translator.ts';
import type { BackupData, BackupRepo } from './backup.ts';
import type { NotesStore } from './notes-ledger.ts';
import type { SeriesRepo } from './series-catalog.ts';

/** key 以 seriesId 開頭的 store（[seriesId, …]）裡，這個 Series 的全部。陣列 key 比任何字串都大。 */
const seriesRange = (seriesId: string) => IDBKeyRange.bound([seriesId], [seriesId, []]);

/** 用 index 找出這個 Series 的每一筆，逐筆交給 visit（同一個 transaction 裡）。 */
function eachBySeries(store: IDBObjectStore, seriesId: string, visit: (cursor: IDBCursorWithValue) => void): void {
  const req = store.index(BY_SERIES).openCursor(seriesId);
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    visit(cursor);
    cursor.continue();
  };
}

/**
 * 翻譯時累積的 Series Notes（#37）。依 index 讀出來是照原文排序（主鍵 [seriesId, 原文]），每次順序相同，
 * prompt cache 才吃得到。條目與建議修改在同一個 transaction 寫入。
 */
export function indexedDbNotesStore(): NotesStore {
  let db: Promise<IDBDatabase> | undefined;
  const bySeries = <T>(store: string, seriesId: string) =>
    storeRequest((db ??= openDb()), store, 'readonly', (s) => s.index(BY_SERIES).getAll(seriesId) as IDBRequest<T[]>);
  return {
    list: (seriesId) => bySeries<NotesEntry>(STORES.seriesNotes, seriesId),
    async load(seriesId) {
      const [entries, suggestions] = await Promise.all([
        bySeries<NotesEntry>(STORES.seriesNotes, seriesId),
        bySeries<NotesSuggestion>(STORES.notesSuggestions, seriesId),
      ]);
      return { entries, suggestions };
    },
    async save(seriesId, { entries, suggestions }) {
      const conn = await (db ??= openDb());
      await new Promise<void>((resolve, reject) => {
        const tx = conn.transaction([STORES.seriesNotes, STORES.notesSuggestions], 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        const notes = tx.objectStore(STORES.seriesNotes);
        for (const entry of entries) notes.put({ ...entry, seriesId });
        // 建議修改整份取代（接受的拿掉、忽略的改了標記）。先拿到舊的 key 再刪：cursor 會看到同一個 transaction 裡新加的。
        const pending = tx.objectStore(STORES.notesSuggestions);
        const old = pending.index(BY_SERIES).getAllKeys(seriesId);
        old.onsuccess = () => {
          for (const key of old.result) pending.delete(key);
          for (const suggestion of suggestions) pending.add({ ...suggestion, seriesId });
        };
      });
    },
  };
}

/** Series、網址模式、合併時要動的快取與 Notes（#36），存在 IndexedDB。 */
export function indexedDbSeriesRepo(): SeriesRepo {
  let db: Promise<IDBDatabase> | undefined;
  const run = <T>(store: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) =>
    storeRequest((db ??= openDb()), store, mode, op);
  const bySeries = <T>(store: string, seriesId: string) =>
    run(store, 'readonly', (s) => s.index(BY_SERIES).getAll(seriesId) as IDBRequest<T[]>);
  return {
    getSeries: (id) => run(STORES.series, 'readonly', (s) => s.get(id) as IDBRequest<Series | undefined>),
    listSeries: () => run(STORES.series, 'readonly', (s) => s.getAll() as IDBRequest<Series[]>),
    putSeries: (series) => run(STORES.series, 'readwrite', (s) => s.put(series)).then(() => {}),
    getPattern: (pattern) => run(STORES.urlPatterns, 'readonly', (s) => s.get(pattern) as IDBRequest<UrlPattern | undefined>),
    listPatterns: () => run(STORES.urlPatterns, 'readonly', (s) => s.getAll() as IDBRequest<UrlPattern[]>),
    putPattern: (pattern) => run(STORES.urlPatterns, 'readwrite', (s) => s.put(pattern)).then(() => {}),
    listTranslations: (seriesId) => bySeries<PageTranslation>(STORES.pageTranslations, seriesId),
    listNotes: (seriesId) => bySeries<NotesEntry>(STORES.seriesNotes, seriesId),
    listSuggestions: (seriesId) => bySeries<NotesSuggestion>(STORES.notesSuggestions, seriesId),
    async commitMerge(merge) {
      const stores = [STORES.series, STORES.pageTranslations, STORES.seriesNotes, STORES.notesSuggestions, STORES.urlPatterns];
      const conn = await (db ??= openDb());
      await new Promise<void>((resolve, reject) => {
        // 一個 transaction：中途失敗就整個不算，不會留下一半在臨時 Series、一半在目標。
        const tx = conn.transaction(stores, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        const { sourceId, targetId } = merge;
        const translations = tx.objectStore(STORES.pageTranslations);
        translations.delete(seriesRange(sourceId));
        for (const t of merge.translations) translations.put(t);
        const notes = tx.objectStore(STORES.seriesNotes);
        notes.delete(seriesRange(sourceId));
        notes.delete(seriesRange(targetId));
        for (const n of merge.notes) notes.put(n);
        const suggestions = tx.objectStore(STORES.notesSuggestions);
        eachBySeries(suggestions, sourceId, (cursor) => cursor.delete());
        for (const s of merge.suggestions) suggestions.add(s);
        eachBySeries(tx.objectStore(STORES.urlPatterns), sourceId, (cursor) => cursor.update({ ...cursor.value, seriesId: targetId }));
        tx.objectStore(STORES.series).delete(sourceId);
      });
    },
  };
}

/** 匯出／匯入（#38）與清除快取用。只碰 Series、網址模式、Notes、建議修改、快取這五個 store；不碰 apiKeys。 */
export function indexedDbBackupRepo(): BackupRepo & { clearTranslations(seriesId: string): Promise<void> } {
  let db: Promise<IDBDatabase> | undefined;
  const run = <T>(store: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) =>
    storeRequest((db ??= openDb()), store, mode, op);
  const all = <T>(store: string) => run(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  return {
    async dump(): Promise<BackupData> {
      const [series, urlPatterns, seriesNotes, notesSuggestions, pageTranslations] = await Promise.all([
        all<Series>(STORES.series),
        all<UrlPattern>(STORES.urlPatterns),
        all<NotesEntry>(STORES.seriesNotes),
        all<NotesSuggestion>(STORES.notesSuggestions),
        all<PageTranslation>(STORES.pageTranslations),
      ]);
      return { series, urlPatterns, seriesNotes, notesSuggestions, pageTranslations };
    },
    getSeries: (id) => run(STORES.series, 'readonly', (s) => s.get(id) as IDBRequest<Series | undefined>),
    putSeries: (series) => run(STORES.series, 'readwrite', (s) => s.put(series)).then(() => {}),
    getPattern: (pattern) => run(STORES.urlPatterns, 'readonly', (s) => s.get(pattern) as IDBRequest<UrlPattern | undefined>),
    putPattern: (pattern) => run(STORES.urlPatterns, 'readwrite', (s) => s.put(pattern)).then(() => {}),
    listTranslations: (seriesId) => run(STORES.pageTranslations, 'readonly', (s) => s.index(BY_SERIES).getAll(seriesId) as IDBRequest<PageTranslation[]>),
    async putTranslations(translations) {
      const conn = await (db ??= openDb());
      await new Promise<void>((resolve, reject) => {
        const tx = conn.transaction(STORES.pageTranslations, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        const store = tx.objectStore(STORES.pageTranslations);
        for (const t of translations) store.put(t);
      });
    },
    clearTranslations: (seriesId) => run(STORES.pageTranslations, 'readwrite', (s) => s.delete(seriesRange(seriesId))).then(() => {}),
  };
}
