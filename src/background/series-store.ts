import { BY_SERIES, openDb, STORES, storeRequest } from '../shared/db.ts';
import type { PageTranslation } from '../shared/page-text.ts';
import type { NotesSuggestion } from '../shared/series-notes.ts';
import type { Series, UrlPattern } from '../shared/series.ts';
import type { NotesEntry } from '../shared/translator.ts';
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
