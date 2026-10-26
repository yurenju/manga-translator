/**
 * Series Notes 的「只能新增」規則（spec #27 第 4.2 節、ADR 0002）。
 * 合併 Series（#36）與套用 LLM 的 notes_changes（#37）共用：新條目直接加、既有條目只補空欄位（含空的譯文），
 * 想改既有（非空）的譯文一律變成 NotesSuggestion，由人在 side panel 接受或忽略。
 */
import type { NotesEntry } from './translator.ts';

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
