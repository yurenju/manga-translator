/**
 * 可替換的 LLM 呼叫介面（spec #27 第 5 節）。v1 的正式實作是 Claude（#31）；
 * e2e 用 FakeTranslator（spec 第 12 節）。LLM 只看文字，永遠不提供座標、不改閱讀順序（ADR 0001）。
 */
import type { Orientation } from './page-text.ts';

/** Series Notes 的一個條目（spec 第 4.2 節）。 */
export interface NotesEntry {
  seriesId: string;
  原文: string;
  讀音: string;
  譯文: string;
  類別: string;
  備註?: string;
  locked: boolean;
  自稱?: string;
  語氣?: string;
  稱呼?: string;
}

/** 一頁翻譯時用到的條目：當時的原文與譯文（快取的 usedNotes，#38 判斷過時用）。 */
export type UsedNote = Pick<NotesEntry, '原文' | '譯文'>;

export interface TranslateInput {
  /** v1 整份送。 */
  seriesNotes: NotesEntry[];
  /** 依閱讀順序。 */
  items: {
    id: string;
    kind: 'balloon' | 'loose';
    原文: string;
    orientation: Orientation;
  }[];
}

/** LLM 對 Series Notes 的變更：新增／補空欄位／建議修改。套用規則在 series-notes.ts（SW 執行）。 */
export interface NotesChanges {
  added: Omit<NotesEntry, 'seriesId' | 'locked'>[];
  /** 補既有條目的空欄位。 */
  filled: { 原文: string; fields: Partial<NotesEntry> }[];
  /** 想改既有條目的譯文。 */
  suggestions: { 原文: string; 建議譯文: string; 理由?: string }[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface TranslateOutput {
  items: { id: string; 讀音: string; 譯文: string; unreadable: boolean }[];
  notes_changes: NotesChanges;
  usage: Usage;
  model: string;
  latencyMs: number;
}

export interface Translator {
  translatePage(input: TranslateInput, signal?: AbortSignal): Promise<TranslateOutput>;
}
