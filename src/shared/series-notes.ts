/**
 * Series Notes 的「只能新增」規則（spec #27 第 4.2 節、ADR 0002）。
 * 合併 Series（#36）與套用 LLM 的 notes_changes（#37）共用：新條目直接加、既有條目只補空欄位（含空的譯文），
 * 想改既有（非空）的譯文一律變成 NotesSuggestion，由人在 side panel 接受或忽略。
 */
import type { NotesChanges, NotesEntry, UsedNote } from './translator.ts';

/** LLM（或合併進來的 Series）想改既有譯名時只能提建議。 */
export interface NotesSuggestion {
  seriesId: string;
  原文: string;
  建議譯文: string;
  理由?: string;
  來源: SuggestionSource;
  /** 人按了「忽略」：不再列出，同樣的建議之後也不再加進來（#38）。 */
  ignored?: true;
}

/** 一部 Series 的 Notes 條目與建議修改。 */
export interface SeriesNotes {
  entries: NotesEntry[];
  suggestions: NotesSuggestion[];
}

/** 一個建議修改的身分：同一個原文、同一個建議譯文就是同一個建議，不管是哪一頁提的。 */
export type SuggestionRef = Pick<NotesSuggestion, '原文' | '建議譯文'>;

const sameSuggestion = (a: SuggestionRef) => (b: SuggestionRef) => a.原文 === b.原文 && a.建議譯文 === b.建議譯文;

/**
 * 建議從哪來：LLM 翻某一頁時提的（pageHash＝那個 Page 的身分，ADR 0002「依頁面順序逐筆套用」），
 * 合併 Series 時從被合併的 Provisional Series 帶進來的（mergedFrom＝它的 ID，合併後已刪除），
 * 或匯入 JSON 時跟本機條目衝突的（imported，#38）。
 */
export type SuggestionSource = { pageHash: string } | { mergedFrom: string } | { imported: true };

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
  /**
   * 這頁送出時的快照裡還沒有、同一個 Spread 先套用的頁剛新增的條目原文（兩頁共用快照，#35）。
   * 這頁對它們的「新增」只補空欄位，譯名不同也不變成建議：這頁根本沒看到那個譯名，不是想改它。
   */
  unseen?: ReadonlySet<string>;
}

/** 比對原文用：忽略全形半形與空白。 */
export const normalizeText = (s: string) => s.normalize('NFKC').replace(/\s/g, '');

/** 原文有沒有出現在某一段文字裡（忽略全形半形與空白）。空的原文不算出現。 */
function appearsIn(texts: readonly string[], 原文: string): boolean {
  const needle = normalizeText(原文);
  return needle !== '' && texts.some((text) => normalizeText(text).includes(needle));
}

/** 原文出現在這些文字裡的條目（快取的 usedNotes，#38 判斷過時用）。 */
export function usedNotes(entries: readonly NotesEntry[], texts: readonly string[]): UsedNote[] {
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
  const unseen = (原文: string) => page.unseen?.has(原文) ?? false;
  const incoming = [
    ...changes.added
      .filter((a) => known.has(a.原文) || appearsIn(page.balloonTexts, a.原文))
      .map((a) => asEntry(unseen(a.原文) ? { ...a, 譯文: '' } : a)),
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

/** 人在 side panel 可以改的欄位（原文是 key，不能改）。 */
export type EditableFields = Partial<Pick<NotesEntry, (typeof FILLABLE)[number]>>;

/** 人在 side panel 修正一個條目：寫進改過的欄位並設成 locked（之後 LLM 只能對它提建議，ADR 0002）。 */
export function editEntry(entries: readonly NotesEntry[], 原文: string, fields: EditableFields): NotesEntry[] {
  return entries.map((e) => (e.原文 === 原文 ? { ...e, ...fields, locked: true } : e));
}

/**
 * 把新的建議修改加進既有的：同一個建議（原文＋建議譯文）已經有了就不加，忽略過的也算。
 * LLM 每翻一頁都可能再提一次同一個建議（#37 沒有去重）。
 */
export function addSuggestions(existing: readonly NotesSuggestion[], incoming: readonly NotesSuggestion[]): NotesSuggestion[] {
  const result = [...existing];
  for (const s of incoming) if (!result.some(sameSuggestion(s))) result.push(s);
  return result;
}

/** side panel 要列出的建議：沒忽略、條目還在、而且跟目前的譯文不同（例如人已經自己改成一樣了）。 */
export function pendingSuggestions({ entries, suggestions }: SeriesNotes): NotesSuggestion[] {
  const byOriginal = new Map(entries.map((e) => [e.原文, e]));
  return suggestions.filter((s) => !s.ignored && byOriginal.has(s.原文) && byOriginal.get(s.原文)!.譯文 !== s.建議譯文);
}

/** 接受建議：條目改成建議譯文並 locked（等於人改過），這個建議拿掉。 */
export function acceptSuggestion(notes: SeriesNotes, ref: SuggestionRef): SeriesNotes {
  return {
    entries: editEntry(notes.entries, ref.原文, { 譯文: ref.建議譯文 }),
    suggestions: notes.suggestions.filter((s) => !sameSuggestion(ref)(s)),
  };
}

/** 忽略建議：條目不動，建議留著但標成忽略，同樣的建議之後不會再加進來。 */
export function ignoreSuggestion(notes: SeriesNotes, ref: SuggestionRef): SeriesNotes {
  return {
    entries: notes.entries,
    suggestions: notes.suggestions.map((s) => (sameSuggestion(ref)(s) ? { ...s, ignored: true } : s)),
  };
}

/** 目前會用來翻譯的模型與 prompt 版本（Translator.version）。 */
export interface TranslatorVersion {
  model: string;
  promptVersion: string;
}

/** 過時的原因：這頁用到的條目譯文被改了（notes），或模型／prompt 版本不同（version）。 */
export type StaleReason = 'notes' | 'version';

/**
 * 快取的這頁是不是過時了（spec #27 第 4.3 節：過時只提示、不自動重翻）。只看這頁翻譯時用到的條目（usedNotes）：
 * 新增條目不算，用到的條目只改了譯文以外的欄位也不算。當時譯文是空的條目之後被 LLM 補上（翻別頁時 filled）也算新增；
 * LLM 只能補空欄位、不能改有值的譯文，所以套用 notes_changes 不會讓任何頁過時，只有人改（locked）會。
 * current 是 undefined（沒有 API key）時不比版本。
 */
export function staleReason(
  page: { usedNotes: readonly UsedNote[]; model: string; promptVersion: string },
  entries: readonly NotesEntry[],
  current: TranslatorVersion | undefined,
): StaleReason | undefined {
  const byOriginal = new Map(entries.map((e) => [e.原文, e]));
  // 條目不在了（不會發生：條目不能刪）就當沒改
  const changed = (u: UsedNote) => {
    const now = byOriginal.get(u.原文);
    return now !== undefined && now.譯文 !== u.譯文 && (u.譯文 !== '' || now.locked);
  };
  if (page.usedNotes.some(changed)) return 'notes';
  if (current && (current.model !== page.model || current.promptVersion !== page.promptVersion)) return 'version';
  return undefined;
}

/**
 * 匯入 JSON（#38）時把檔案裡這部 Series 的 Notes 併進本機的：跟合併 Series 同一套只能新增規則，本機已有的條目優先，
 * 譯文衝突變成建議修改。本機沒有的條目照原樣加進來（另一台電腦上人改過的仍是 locked）。檔案裡的建議去重後加進來。
 */
export function mergeImportedNotes(local: SeriesNotes, incoming: SeriesNotes, seriesId: string): SeriesNotes {
  const merged = mergeNotes(local.entries, incoming.entries, { seriesId, 來源: { imported: true } });
  const imported = incoming.suggestions.map((s) => ({ ...s, seriesId }));
  return { entries: merged.entries, suggestions: addSuggestions(addSuggestions(local.suggestions, imported), merged.suggestions) };
}
