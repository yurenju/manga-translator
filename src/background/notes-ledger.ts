/**
 * Series Notes 累積（#37、spec #27 第 3.4 節）：每頁送出 LLM 時拿一份 Notes 快照，回來後依「送出 LLM 的順序」
 * 套用 notes_changes——後送出的先回來也要等前面的套用完（或失敗放掉）。套用規則在 shared/series-notes.ts。
 * 同一個 Spread 的兩頁拿到同一份快照：後送出的那頁不會看到先送出那頁的變更（spec 第 3.4 節）。
 */
import { applyNotesChanges, type NotesPage, type NotesSuggestion } from '../shared/series-notes.ts';
import type { NotesChanges, NotesEntry } from '../shared/translator.ts';

export interface NotesStore {
  /** 這個 Series 的全部條目，每次呼叫順序相同（prompt cache 要逐字一致）。 */
  list(seriesId: string): Promise<NotesEntry[]>;
  /** 一次寫入：這個 Series 的全部條目（以原文為 key 覆寫）與新的建議修改。 */
  save(seriesId: string, entries: NotesEntry[], suggestions: NotesSuggestion[]): Promise<void>;
}

/** 一頁送出 LLM 時拿到的號碼牌。commit 與 release 只能擇一呼叫一次。 */
export interface NotesTurn {
  /** 送出時的 Notes 快照（送進 prompt）。 */
  notes: Promise<NotesEntry[]>;
  /** 輪到這頁時套用它的變更；回傳套用後的全部條目。寫不進去就回傳快照，不擋翻譯結果。 */
  commit(changes: NotesChanges, page: Omit<NotesPage, 'seriesId'>): Promise<NotesEntry[]>;
  /** 翻譯失敗：不套用，只讓出順序。 */
  release(): void;
}

export function createNotesLedger(store: NotesStore) {
  /** 每個 Series 最後一張號碼牌輪完時 resolve。 */
  const tails = new Map<string, Promise<void>>();
  /** Spread 記號 → 第一頁送出時拿的快照。記號不再被引用（那次排程結束）就自動放掉。 */
  const snapshots = new WeakMap<object, Promise<NotesEntry[]>>();

  return {
    /**
     * 送出 LLM 的那一刻呼叫（同步拿號碼牌，順序＝送出順序）。spread：同一個 Spread 的頁面傳同一個記號，
     * 共用第一頁拿的快照。
     */
    checkout(seriesId: string, spread?: object): NotesTurn {
      const previous = tails.get(seriesId) ?? Promise.resolve();
      let done!: () => void;
      const turn = new Promise<void>((resolve) => (done = resolve));
      tails.set(seriesId, turn);
      void turn.then(() => {
        if (tails.get(seriesId) === turn) tails.delete(seriesId);
      });
      const notes =
        (spread && snapshots.get(spread)) ??
        store.list(seriesId).catch((e: unknown) => {
          console.warn('notes lookup failed', e);
          return [];
        });
      if (spread) snapshots.set(spread, notes);
      return {
        notes,
        async commit(changes, page) {
          try {
            await previous;
            const merged = applyNotesChanges(await store.list(seriesId), changes, { ...page, seriesId });
            await store.save(seriesId, merged.entries, merged.suggestions);
            return merged.entries;
          } catch (e) {
            console.warn('notes save failed', e);
            return notes;
          } finally {
            done();
          }
        },
        release() {
          void previous.then(done);
        },
      };
    },
  };
}

export type NotesLedger = ReturnType<typeof createNotesLedger>;
