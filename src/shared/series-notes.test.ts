import { describe, expect, it } from 'vitest';
import { applyNotesChanges, mergeNotes } from './series-notes.ts';
import type { NotesEntry } from './translator.ts';

const entry = (seriesId: string, 原文: string, 譯文: string, more: Partial<NotesEntry> = {}): NotesEntry => ({
  seriesId,
  原文,
  讀音: '',
  譯文,
  類別: '人名',
  locked: false,
  ...more,
});

describe('mergeNotes（只能新增）', () => {
  it('目標沒有的條目直接新增，改掛在目標 Series 下', () => {
    const result = mergeNotes([entry('t', '霧島湊', '霧島湊')], [entry('p', '潮見坂', '潮見坂', { 類別: '地名' })], {
      seriesId: 't',
      來源: { mergedFrom: 'p' },
    });

    expect(result.entries).toEqual([entry('t', '霧島湊', '霧島湊'), entry('t', '潮見坂', '潮見坂', { 類別: '地名' })]);
    expect(result.suggestions).toEqual([]);
  });

  it('同一個原文、譯文不同：保留目標的譯文，另一個變成建議修改', () => {
    const result = mergeNotes([entry('t', '相棒', '搭檔')], [entry('p', '相棒', '夥伴')], { seriesId: 't', 來源: { mergedFrom: 'p' } });

    expect(result.entries).toEqual([entry('t', '相棒', '搭檔')]);
    expect(result.suggestions).toEqual([{ seriesId: 't', 原文: '相棒', 建議譯文: '夥伴', 來源: { mergedFrom: 'p' } }]);
  });

  it('同一個原文、譯文相同：不產生建議', () => {
    const result = mergeNotes([entry('t', '相棒', '搭檔')], [entry('p', '相棒', '搭檔')], { seriesId: 't', 來源: { mergedFrom: 'p' } });

    expect(result.suggestions).toEqual([]);
  });

  it('既有條目的空欄位可以補上，有值的欄位不動', () => {
    const result = mergeNotes(
      [entry('t', '兄ちゃん', '哥', { 讀音: '' })],
      [entry('p', '兄ちゃん', '哥', { 讀音: 'にいちゃん', 類別: '用語', 備註: '湊叫哥哥' })],
      { seriesId: 't', 來源: { mergedFrom: 'p' } },
    );

    expect(result.entries).toEqual([entry('t', '兄ちゃん', '哥', { 讀音: 'にいちゃん', 備註: '湊叫哥哥' })]);
  });

  it('既有條目的譯文是空的：直接補上，不變成建議', () => {
    const result = mergeNotes([entry('t', '潮見坂', '', { 類別: '地名' })], [entry('p', '潮見坂', '潮見坂', { 類別: '地名' })], {
      seriesId: 't',
      來源: { mergedFrom: 'p' },
    });

    expect(result.entries).toEqual([entry('t', '潮見坂', '潮見坂', { 類別: '地名' })]);
    expect(result.suggestions).toEqual([]);
  });

  it('人改過（locked）的條目不補欄位，譯文不同仍然變成建議', () => {
    const locked = entry('t', 'ミオ', '美緒', { locked: true });
    const result = mergeNotes([locked], [entry('p', 'ミオ', '米歐', { 讀音: 'みお' })], { seriesId: 't', 來源: { mergedFrom: 'p' } });

    expect(result.entries).toEqual([locked]);
    expect(result.suggestions).toEqual([{ seriesId: 't', 原文: 'ミオ', 建議譯文: '米歐', 來源: { mergedFrom: 'p' } }]);
  });
});

describe('applyNotesChanges（套用 LLM 的 notes_changes）', () => {
  const page = { seriesId: 's', pageHash: 'h1', balloonTexts: ['ミナちゃん、待って！', '潮見坂まで走るよ'] };
  const none = { added: [], filled: [], suggestions: [] };
  const added = (原文: string, 譯文: string, more: Partial<NotesEntry> = {}) => ({ 原文, 讀音: '', 譯文, 類別: '人名', ...more });

  it('原文出現在這頁某個 Balloon 裡的新條目直接加進 Notes（未 locked）', () => {
    const result = applyNotesChanges([], { ...none, added: [added('ミナ', '美娜')] }, page);

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜')]);
    expect(result.suggestions).toEqual([]);
  });

  it('原文不在任何 Balloon 裡（例如封面上 OCR 讀錯的標題）不採用', () => {
    const result = applyNotesChanges([], { ...none, added: [added('魔法少女ミチ', '魔法少女美琪', { 類別: '用語' })] }, page);

    expect(result.entries).toEqual([]);
  });

  it('filled 只補既有條目的空欄位；Notes 裡沒有的原文不會因此新增', () => {
    const result = applyNotesChanges(
      [entry('s', 'ミナ', '美娜', { 讀音: '' })],
      { ...none, filled: [{ 原文: 'ミナ', fields: { 讀音: 'みな', 自稱: 'あたし' } }, { 原文: '潮見坂', fields: { 讀音: 'しおみざか' } }] },
      page,
    );

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜', { 讀音: 'みな', 自稱: 'あたし' })]);
  });

  it('suggestions 變成帶來源 Page 的建議修改，條目本身不動；Notes 裡沒有的原文或譯文相同的建議不算', () => {
    const notes = [entry('s', 'ミナ', '美娜')];
    const result = applyNotesChanges(
      notes,
      {
        ...none,
        suggestions: [
          { 原文: 'ミナ', 建議譯文: '米娜', 理由: '音較接近' },
          { 原文: 'ミナ', 建議譯文: '美娜' },
          { 原文: '潮見坂', 建議譯文: '潮見坡' },
        ],
      },
      page,
    );

    expect(result.entries).toEqual(notes);
    expect(result.suggestions).toEqual([{ seriesId: 's', 原文: 'ミナ', 建議譯文: '米娜', 理由: '音較接近', 來源: { pageHash: 'h1' } }]);
  });

  it('同一個原文先到先贏：再次新增不同譯文不覆蓋，變成建議修改', () => {
    const result = applyNotesChanges([entry('s', 'ミナ', '美娜')], { ...none, added: [added('ミナ', '米娜')] }, page);

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜')]);
    expect(result.suggestions).toEqual([{ seriesId: 's', 原文: 'ミナ', 建議譯文: '米娜', 來源: { pageHash: 'h1' } }]);
  });

  it('人改過（locked）的條目：空欄位也不補', () => {
    const locked = entry('s', 'ミナ', '美娜', { locked: true });
    const result = applyNotesChanges(
      [locked],
      { ...none, added: [added('ミナ', '美娜', { 讀音: 'みな' })], filled: [{ 原文: 'ミナ', fields: { 語氣: '活潑' } }] },
      page,
    );

    expect(result.entries).toEqual([locked]);
  });

  it('原文是空字串的條目不採用', () => {
    const result = applyNotesChanges([], { ...none, added: [added('', '某人')] }, page);

    expect(result.entries).toEqual([]);
  });
});
