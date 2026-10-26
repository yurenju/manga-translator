import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageCandidate, PageThumb } from '../shared/messages.ts';
import { createScanner, type ScannerDeps } from './scan.ts';

const VIEWPORT = { width: 1280, height: 720 };
const P1: PageCandidate = { anchorId: 'a1', rect: { x: 425, y: 57, width: 430, height: 625 } };
const WINDOW_ID = 7;

/** 用記憶體模擬 content script、captureVisibleTab、offscreen。 */
function fakeDeps(candidates: PageCandidate[] = [P1]) {
  const captures: number[] = [];
  const published: [number, PageThumb[]][] = [];
  const env = {
    viewport: VIEWPORT,
    candidates,
    visible: true,
    /** 每次量 rect 花的時間（ms），依序取用；用完就是 0。 */
    findDelays: [] as number[],
    /** 截圖當下頁面發生的事（例如 side panel 打開、版面重排）。 */
    onCapture: () => {},
  };
  const deps: ScannerDeps = {
    findPageCandidates: async () => {
      const delay = env.findDelays.shift() ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return { viewport: env.viewport, candidates: env.candidates };
    },
    getVisibleWindowId: async () => (env.visible ? WINDOW_ID : undefined),
    captureWindow: async (windowId) => {
      expect(windowId).toBe(WINDOW_ID);
      captures.push(Date.now());
      env.onCapture();
      return `data:image/png;base64,SCREENSHOT${captures.length}`;
    },
    crop: async ({ screenshot, candidates }) =>
      candidates.map((c) => ({ anchorId: c.anchorId, rect: c.rect, thumbnail: `thumb(${screenshot},${c.anchorId})`, pageHash: c.anchorId })),
    publish: (tabId, pages) => void published.push([tabId, pages]),
  };
  return { deps, captures, published, env };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 等掃描做完；中間的限速等待用假時鐘快轉。 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('scan', () => {
  it('截圖、依候選裁切，並公布這個 tab 的 Page 縮圖', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);

    await settle(scanner.scan(1));

    const expected = [{ anchorId: 'a1', rect: P1.rect, thumbnail: 'thumb(data:image/png;base64,SCREENSHOT1,a1)', pageHash: 'a1' }];
    expect(chrome.published).toEqual([[1, expected]]);
    expect(scanner.getPages(1)).toEqual(expected);
  });

  it('公布時一併給出截圖與量到的版面，讓後面的流水線用全解析度的 Page', async () => {
    const chrome = fakeDeps();
    const captures: unknown[] = [];
    const scanner = createScanner({ ...chrome.deps, publish: (_tabId, _pages, capture) => void captures.push(capture) });

    await settle(scanner.scan(1));

    expect(captures).toEqual([{ screenshot: 'data:image/png;base64,SCREENSHOT1', viewport: VIEWPORT, candidates: [P1] }]);
  });

  it('沒有 Page 候選就不截圖，公布空清單', async () => {
    const chrome = fakeDeps([]);
    const scanner = createScanner(chrome.deps);

    await settle(scanner.scan(1));

    expect(chrome.captures).toEqual([]);
    expect(chrome.published).toEqual([[1, []]]);
  });

  it('tab 不在前景就不截圖（否則會截到別的 tab），保留上一次的結果', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);
    await settle(scanner.scan(1));

    chrome.env.visible = false;
    await settle(scanner.scan(1));

    expect(chrome.captures).toHaveLength(1);
    expect(chrome.published).toHaveLength(1);
    expect(scanner.getPages(1)).toHaveLength(1);
  });

  it('連續觸發時截圖間隔至少 500 ms（≤2 次/秒），跨 tab 也算', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);

    chrome.env.findDelays = [120, 0, 300, 0, 50, 0, 200];
    const scans = [1, 1, 2, 1, 2].map((tabId) => scanner.scan(tabId));
    await settle(Promise.all(scans));

    expect(chrome.captures).toHaveLength(5);
    const gaps = chrome.captures.slice(1).map((t, i) => t - chrome.captures[i]!);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(500);
  });

  it('截圖期間版面變了（例如 side panel 剛打開）就重新量、重新截圖', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);
    const shifted: PageCandidate = { anchorId: 'a1', rect: { x: 221, y: 57, width: 430, height: 625 } };
    chrome.env.onCapture = () => {
      chrome.env.viewport = { width: 872, height: 720 };
      chrome.env.candidates = [shifted];
      chrome.env.onCapture = () => {};
    };

    await settle(scanner.scan(1));

    expect(chrome.captures).toHaveLength(2);
    expect(scanner.getPages(1)).toEqual([
      { anchorId: 'a1', rect: shifted.rect, thumbnail: 'thumb(data:image/png;base64,SCREENSHOT2,a1)', pageHash: 'a1' },
    ]);
  });

  it('clear 之後清掉結果，進行中的掃描也不再公布', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);
    await settle(scanner.scan(1));

    const inFlight = scanner.scan(1);
    scanner.clear(1);
    await settle(inFlight);

    expect(scanner.getPages(1)).toEqual([]);
    expect(chrome.published.at(-1)).toEqual([1, []]);
  });
});
