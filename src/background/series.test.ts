import { describe, expect, it } from 'vitest';
import { provisionalSeries } from './series.ts';

describe('provisionalSeries', () => {
  it('名稱是「未命名・網站・月/日」，標成 provisional', () => {
    const series = provisionalSeries('https://shonenjumpplus.com/episode/3270375685', new Date(2026, 9, 25, 23, 10), 'id-1');

    expect(series).toEqual({ id: 'id-1', name: '未命名・shonenjumpplus.com・10/25', provisional: true, createdAt: new Date(2026, 9, 25, 23, 10).getTime() });
  });
});
