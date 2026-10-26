import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageTurnSignal, PAGE_TURN_DEBOUNCE_MS, watchPageTurns, type PageTurnWatchDeps } from './page-turn.ts';

describe('翻頁訊號', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('連續的事件（翻頁動畫、捲動）停下 debounce 時間後只通知一次', () => {
    const notify = vi.fn();
    const signal = createPageTurnSignal({ notify });

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
    const signal = createPageTurnSignal({ notify });

    signal.fire();
    signal.cancel();
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS * 2);
    signal.fire();
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS * 2);

    expect(notify).not.toHaveBeenCalled();
  });
});

/** 假的 DOM 節點：isOwn 用 own 判斷是不是覆蓋層自己的。 */
type FakeNode = { own: boolean };
const node = (own: boolean) => ({ own }) as FakeNode as unknown as Node;

function setup() {
  const notify = vi.fn();
  const document = Object.assign(new EventTarget(), { documentElement: node(false) });
  const window = new EventTarget();
  let onMutation: MutationCallback | undefined;
  const disconnect = vi.fn();
  class FakeObserver {
    constructor(callback: MutationCallback) {
      onMutation = callback;
    }
    observe() {}
    disconnect = disconnect;
  }
  const deps: PageTurnWatchDeps = {
    notify,
    isOwn: (n, attribute) => (n as unknown as FakeNode).own || attribute === 'data-own',
    document,
    window,
    MutationObserver: FakeObserver,
  };
  const stop = watchPageTurns(deps);
  const mutate = (records: Partial<MutationRecord>[]) => onMutation!(records as MutationRecord[], {} as MutationObserver);
  const childList = (...nodes: Node[]): Partial<MutationRecord> => ({ type: 'childList', addedNodes: nodes as unknown as NodeList, removedNodes: [] as unknown as NodeList });
  return { notify, document, window, stop, mutate, childList, disconnect };
}

describe('watchPageTurns', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('頁面的捲動、按鍵、img load、resize 都會在 debounce 後通知', () => {
    for (const fire of [
      (t: ReturnType<typeof setup>) => t.document.dispatchEvent(new Event('scroll')),
      (t: ReturnType<typeof setup>) => t.document.dispatchEvent(new Event('keydown')),
      (t: ReturnType<typeof setup>) => t.document.dispatchEvent(new Event('load')),
      (t: ReturnType<typeof setup>) => t.window.dispatchEvent(new Event('resize')),
    ]) {
      const t = setup();
      fire(t);
      vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
      expect(t.notify).toHaveBeenCalledTimes(1);
      t.stop();
    }
  });

  it('頁面自己的 DOM 變動會通知；只有覆蓋層自己的變動不算翻頁', () => {
    const t = setup();

    t.mutate([t.childList(node(true)), { type: 'attributes', target: node(false), attributeName: 'data-own' }]);
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).not.toHaveBeenCalled();

    t.mutate([t.childList(node(true), node(false))]);
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('拆掉之後事件不再通知，MutationObserver 也斷開', () => {
    const t = setup();

    t.stop();
    t.document.dispatchEvent(new Event('scroll'));
    t.window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS * 2);

    expect(t.notify).not.toHaveBeenCalled();
    expect(t.disconnect).toHaveBeenCalled();
  });
});
