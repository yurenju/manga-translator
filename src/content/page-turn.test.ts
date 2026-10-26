import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageTurnSignal, PAGE_TURN_DEBOUNCE_MS } from './page-turn.ts';

describe('翻頁訊號', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('連續的事件（翻頁動畫、捲動）停下 debounce 時間後只通知一次', () => {
    const notify = vi.fn();
    const signal = createPageTurnSignal(notify);

    signal.fire();
    vi.advanceTimersByTime(200);
    signal.fire();
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS - 1);
    expect(notify).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('debounce 在 300–500 ms 之間（spec 第 3.2 節）', () => {
    expect(PAGE_TURN_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
    expect(PAGE_TURN_DEBOUNCE_MS).toBeLessThanOrEqual(500);
  });

  it('停止後不再通知', () => {
    const notify = vi.fn();
    const signal = createPageTurnSignal(notify);

    signal.fire();
    signal.cancel();
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS * 2);
    signal.fire();
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS * 2);

    expect(notify).not.toHaveBeenCalled();
  });
});
