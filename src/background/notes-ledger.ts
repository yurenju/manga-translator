/**
 * Series Notes 累積（#37、spec #27 第 3.4 節）：每頁送出 LLM 時拿一份 Notes 快照，回來後依「送出 LLM 的順序」
 * 套用 notes_changes——後送出的先回來也要等前面的套用完（或失敗放掉）。套用規則在 shared/series-notes.ts。
 * 同一個 Spread 的兩頁拿到同一份快照：後送出的那頁不會看到先送出那頁的變更（spec 第 3.4 節）。
 *
 * 人在 side panel 的修改（#38：編輯條目、接受／忽略建議、匯入）也從這裡寫：每次「讀 → 改 → 寫」互斥，
 * 跟套用 LLM 的變更不會互相蓋掉；但不排進送出順序，不必等還在翻的頁回來。
 */
import { addSuggestions, applyNotesChanges, type NotesPage, type SeriesNotes } from '../shared/series-notes.ts';
import type { NotesChanges, NotesEntry } from '../shared/translator.ts';

export interface NotesStore {
  /** 這個 Series 的全部條目，每次呼叫順序相同（prompt cache 要逐字一致）。 */
  list(seriesId: string): Promise<NotesEntry[]>;
  /** 這個 Series 的條目與建議修改。 */
  load(seriesId: string): Promise<SeriesNotes>;
  /** 一次寫入：全部條目（以原文為 key 覆寫）與全部建議修改（取代原本的）。 */
  save(seriesId: string, notes: SeriesNotes): Promise<void>;
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
  /**
   * Spread 記號 → 第一頁送出時拿的快照，與這組裡已套用的頁新增的條目原文（後面的頁看不到它們）。
   * 記號不再被引用（那次排程結束）就自動放掉。
   */
  const snapshots = new WeakMap<object, { notes: Promise<NotesEntry[]>; added: Set<string> }>();
  /** 每個 Series 最後一次「讀 → 改 → 寫」做完時 resolve。 */
  const writes = new Map<string, Promise<unknown>>();

  /** 讀 → 改 → 寫，同一個 Series 一次只跑一個。 */
  function exclusive(seriesId: string, change: (notes: SeriesNotes) => SeriesNotes): Promise<SeriesNotes> {
    const run = (writes.get(seriesId) ?? Promise.resolve()).then(async () => {
      const next = change(await store.load(seriesId));
      await store.save(seriesId, next);
      return next;
    });
    const settled = run.catch(() => {});
    writes.set(seriesId, settled);
    void settled.then(() => {
      if (writes.get(seriesId) === settled) writes.delete(seriesId);
    });
    return run;
  }

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
      const shared =
        (spread && snapshots.get(spread)) ?? {
          notes: store.list(seriesId).catch((e: unknown) => {
            console.warn('notes lookup failed', e);
            return [];
          }),
          added: new Set<string>(),
        };
      if (spread) snapshots.set(spread, shared);
      const { notes } = shared;
      return {
        notes,
        async commit(changes, page) {
          try {
            await previous;
            const next = await exclusive(seriesId, (current) => {
              const merged = applyNotesChanges(current.entries, changes, { ...page, seriesId, unseen: new Set(shared.added) });
              const before = new Set(current.entries.map((e) => e.原文));
              for (const e of merged.entries) if (!before.has(e.原文)) shared.added.add(e.原文);
              return { entries: merged.entries, suggestions: addSuggestions(current.suggestions, merged.suggestions) };
            });
            return next.entries;
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

    /** 人在 side panel 的修改：不等送出順序，只跟其他寫入互斥。回傳改完的 Notes。 */
    update: exclusive,
  };
}

export type NotesLedger = ReturnType<typeof createNotesLedger>;
