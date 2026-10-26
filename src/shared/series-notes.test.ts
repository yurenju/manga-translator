import { describe, expect, it } from 'vitest';
import { mergeNotes } from './series-notes.ts';
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
