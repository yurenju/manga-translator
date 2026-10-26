/**
 * Series Notes 的「只能新增」規則（spec #27 第 4.2 節、ADR 0002）。
 * 合併 Series（#36）與套用 LLM 的 notes_changes（#37）共用：新條目直接加、既有條目只補空欄位（含空的譯文），
 * 想改既有（非空）的譯文一律變成 NotesSuggestion，由人在 side panel 接受或忽略。
 */
import type { NotesChanges, NotesEntry } from './translator.ts';

/** LLM（或合併進來的 Series）想改既有譯名時只能提建議。 */
export interface NotesSuggestion {
  seriesId: string;
  原文: string;
  建議譯文: string;
  理由?: string;
  來源: SuggestionSource;
}

/**
 * 建議從哪來：LLM 翻某一頁時提的（pageHash＝那個 Page 的身分，ADR 0002「依頁面順序逐筆套用」），
 * 或合併 Series 時從被合併的 Provisional Series 帶進來的（mergedFrom＝它的 ID，合併後已刪除）。
 */
export type SuggestionSource = { pageHash: string } | { mergedFrom: string };

/** 空字串＝沒有值，可以補。譯文也算：目標的譯文是空的就直接補上，有值且不同才變成建議。 */
const FILLABLE = ['讀音', '譯文', '類別', '備註', '自稱', '語氣', '稱呼'] as const;

export interface MergedNotes {
  /** 目標 Series 合併後的全部條目（既有的在前，順序不變）。 */
  entries: NotesEntry[];
  /** 這次新產生的建議修改。 */
  suggestions: NotesSuggestion[];
}

/**
 * 把 incoming 依只能新增規則併進 target。同一個原文先到先贏：target 已有的優先。
 * 人改過（locked）的條目不補欄位。
 */
export function mergeNotes(
  target: readonly NotesEntry[],
  incoming: readonly NotesEntry[],
  into: { seriesId: string; 來源: SuggestionSource },
): MergedNotes {
  const entries = target.map((e) => ({ ...e }));
  const byOriginal = new Map(entries.map((e) => [e.原文, e]));
  const suggestions: NotesSuggestion[] = [];
  for (const next of incoming) {
    const existing = byOriginal.get(next.原文);
    if (!existing) {
      const added = { ...next, seriesId: into.seriesId };
      entries.push(added);
      byOriginal.set(added.原文, added);
      continue;
    }
    const fillsTranslation = !existing.譯文 && !existing.locked;
    if (next.譯文 && next.譯文 !== existing.譯文 && !fillsTranslation) {
      suggestions.push({ seriesId: into.seriesId, 原文: next.原文, 建議譯文: next.譯文, 來源: into.來源 });
    }
    if (existing.locked) continue;
    for (const field of FILLABLE) {
      const value = next[field];
      if (!existing[field] && value) existing[field] = value;
    }
  }
  return { entries, suggestions };
}

/** 這次 LLM 回應所屬的 Page。 */
export interface NotesPage {
  seriesId: string;
  pageHash: string;
  /** 這頁每個 Balloon 的 OCR 原文。 */
  balloonTexts: readonly string[];
}

const normalize = (s: string) => s.normalize('NFKC').replace(/\s/g, '');

/** 原文有沒有出現在某一段文字裡（忽略全形半形與空白）。空的原文不算出現。 */
function appearsIn(texts: readonly string[], 原文: string): boolean {
  const needle = normalize(原文);
  return needle !== '' && texts.some((text) => normalize(text).includes(needle));
}

/** 原文出現在這些文字裡的條目（快取的 usedNotes，#38 判斷過時用）。 */
export function usedNotes(entries: readonly NotesEntry[], texts: readonly string[]): { 原文: string; 譯文: string }[] {
  return entries.filter((e) => appearsIn(texts, e.原文)).map(({ 原文, 譯文 }) => ({ 原文, 譯文 }));
}

/**
 * 依只能新增規則套用 LLM 翻某一頁時回傳的 notes_changes（#37）。規則由這裡執行，不交給 LLM 判斷。
 * OCR 錯字防護：新條目的原文必須出現在這頁某個 Balloon 的原文裡才採用。封面、扉頁的設計字與署名多半是
 * Loose Text 而且常被 OCR 讀錯，照先到先贏規則，錯的版本一旦進來就會卡住之後正確的版本（#37、#48 的觀察）。
 */
export function applyNotesChanges(notes: readonly NotesEntry[], changes: NotesChanges, page: NotesPage): MergedNotes {
  const known = new Set(notes.map((e) => e.原文));
  const asEntry = (e: Partial<NotesEntry> & { 原文: string }): NotesEntry => ({
    讀音: '',
    譯文: '',
    類別: '',
    ...e,
    seriesId: page.seriesId,
    locked: false,
  });
  const incoming = [
    ...changes.added.filter((a) => known.has(a.原文) || appearsIn(page.balloonTexts, a.原文)).map(asEntry),
    // 補空欄位只對既有條目有意義
    ...changes.filled.filter((f) => known.has(f.原文)).map((f) => asEntry({ ...f.fields, 原文: f.原文 })),
  ];
  const 來源 = { pageHash: page.pageHash };
  const merged = mergeNotes(notes, incoming, { seriesId: page.seriesId, 來源 });
  const byOriginal = new Map(merged.entries.map((e) => [e.原文, e]));
  for (const { 原文, 建議譯文, 理由 } of changes.suggestions) {
    const existing = byOriginal.get(原文);
    if (!existing || !建議譯文 || 建議譯文 === existing.譯文) continue;
    merged.suggestions.push({ seriesId: page.seriesId, 原文, 建議譯文, ...(理由 ? { 理由 } : {}), 來源 });
  }
  return merged;
}
