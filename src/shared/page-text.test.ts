import { describe, expect, it } from 'vitest';
import { overlaidBalloons, type BalloonText, type PageText } from './page-text.ts';

const rect = { x: 0, y: 0, w: 0.1, h: 0.1 };

const balloon = (id: string, overrides: Partial<BalloonText> = {}): BalloonText => ({
  id,
  order: 1,
  balloonBbox: rect,
  textBbox: rect,
  orientation: 'vertical',
  原文: 'はい',
  讀音: 'はい',
  讀音來源: 'llm',
  譯文: '好',
  unreadable: false,
  ...overrides,
});

const page = (balloons: BalloonText[]): PageText => ({
  balloons,
  looseText: [{ id: 'l1', order: 9, bbox: rect, orientation: 'horizontal', 原文: 'ドン', 讀音: 'どん', 讀音來源: 'llm', 譯文: '咚', unreadable: false }],
});

describe('overlaidBalloons：要覆蓋的 Balloon', () => {
  it('有譯文的 Balloon 覆蓋；unreadable（LLM 判斷亂碼或 OCR 信心低於門檻）與還沒譯文的不覆蓋', () => {
    const text = page([balloon('b1'), balloon('b2', { unreadable: true, 譯文: '硬翻的譯文' }), balloon('b3', { 譯文: '' })]);

    expect(overlaidBalloons(text).map((b) => b.id)).toEqual(['b1']);
  });

  it('舊快取沒有 ocrConfidence：照 unreadable 判斷，跟以前一樣覆蓋', () => {
    const text = page([balloon('b1', { ocrConfidence: undefined })]);

    expect(overlaidBalloons(text).map((b) => b.id)).toEqual(['b1']);
  });
});
