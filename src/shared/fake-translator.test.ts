import { describe, expect, it } from 'vitest';
import { readGroundTruth } from '../testing/synthetic.ts';
import { createFakeTranslator, NO_MATCH } from './fake-translator.ts';

const translator = createFakeTranslator([readGroundTruth('p01-basic'), readGroundTruth('p04-outside')]);

describe('FakeTranslator', () => {
  it('依原文找到合成頁 ground truth，回傳它的讀音與譯文；OCR 錯一兩個字也找得到', async () => {
    const output = await translator.translatePage({
      seriesNotes: [],
      items: [
        { id: 'b1', kind: 'balloon', 原文: 'おはよう！今日は早いね', orientation: 'vertical' },
        // OCR 把「行」讀錯、少了「？」
        { id: 'b2', kind: 'balloon', 原文: '一緒に行ってもいい', orientation: 'vertical' },
        { id: 'l1', kind: 'loose', 原文: 'ハァ…ハァ…', orientation: 'vertical' },
      ],
    });

    expect(output.items).toEqual([
      { id: 'b1', 讀音: 'おはよう！きょうははやいね', 譯文: '早安！今天好早喔', unreadable: false },
      { id: 'b2', 讀音: 'いっしょにいってもいい？', 譯文: '我可以一起去嗎？', unreadable: false },
      { id: 'l1', 讀音: 'ハァ…ハァ…', 譯文: '（喘氣）哈…哈…', unreadable: false },
    ]);
  });

  it('找不到對應的原文時回傳固定字串', async () => {
    const output = await translator.translatePage({
      seriesNotes: [],
      items: [{ id: 'x', kind: 'balloon', 原文: '全然関係ない文章です', orientation: 'vertical' }],
    });

    expect(output.items).toEqual([{ id: 'x', 讀音: '', 譯文: NO_MATCH, unreadable: false }]);
  });

  it('不花錢、不改 Series Notes', async () => {
    const output = await translator.translatePage({ seriesNotes: [], items: [] });

    expect(output.usage.costUsd).toBe(0);
    expect(output.notes_changes).toEqual({ added: [], filled: [], suggestions: [] });
    expect(output.model).toBe('fake');
  });
});
