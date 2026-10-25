/**
 * 找 Page → 截圖 → 裁切（spec #27 第 3.2 節）。
 * Chrome API 與其他 context 都從 deps 注入，SW 的 index.ts 負責接上真的 chrome.*。
 */
import type { CropRequest, PageCandidatesResponse, PageThumb } from '../shared/messages.ts';

/**
 * 兩次 captureVisibleTab 之間至少隔這麼久。Chrome 限制每個外掛最多 2 次/秒，超過會直接丟錯（#4）；
 * 多留 50 ms 給 SW 與瀏覽器之間的 IPC 時間差。
 */
export const CAPTURE_INTERVAL_MS = 550;

/** 版面一直在變（例如持續捲動）時最多試幾次，之後放棄，等下一次觸發。 */
const MAX_ATTEMPTS = 3;

export interface ScannerDeps {
  findPageCandidates(tabId: number): Promise<PageCandidatesResponse>;
  /** tab 是它視窗裡的作用中 tab 就回傳 windowId；否則 undefined（captureVisibleTab 只截得到作用中 tab）。 */
  getVisibleWindowId(tabId: number): Promise<number | undefined>;
  /** 截圖。要在呼叫當下就送出 captureVisibleTab，限速是以呼叫的時間計算。 */
  captureWindow(windowId: number): Promise<string>;
  crop(request: CropRequest): Promise<PageThumb[]>;
  /** capture＝這次的截圖與版面（沒有 Page 或停止時是 undefined），給後面的本機流水線裁全解析度的 Page。 */
  publish(tabId: number, pages: PageThumb[], capture?: CropRequest): void;
}

export function createScanner(deps: ScannerDeps) {
  const pages = new Map<number, PageThumb[]>();
  /** clear() 就加一；掃描開始時記下來，做完時不同就丟掉結果。 */
  const generations = new Map<number, number>();
  /** 掃描一次只跑一個（跨 tab），限速才算得準。 */
  let queue: Promise<void> = Promise.resolve();
  let lastCaptureAt = -Infinity;

  async function waitForCaptureAllowed(): Promise<void> {
    const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  /** 截圖前後量到的版面一樣，才能確定 rect 對得上截圖。 */
  function sameLayout(a: PageCandidatesResponse, b: PageCandidatesResponse): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async function scanOnce(tabId: number, generation: number): Promise<void> {
    const isCurrentGeneration = () => (generations.get(tabId) ?? 0) === generation;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // 等完才量 rect，rect 才不會在等待期間過時。
      await waitForCaptureAllowed();
      if (!isCurrentGeneration()) return;
      const before = await deps.findPageCandidates(tabId);
      if (before.candidates.length === 0) {
        if (isCurrentGeneration()) publish(tabId, []);
        return;
      }
      const windowId = await deps.getVisibleWindowId(tabId);
      if (windowId === undefined) return;
      lastCaptureAt = Date.now();
      const screenshot = await deps.captureWindow(windowId);
      // side panel 剛打開造成重排、使用者在截圖時捲動……rect 跟截圖對不上就重來。
      if (!sameLayout(before, await deps.findPageCandidates(tabId))) continue;
      const capture: CropRequest = { screenshot, ...before };
      const result = await deps.crop(capture);
      if (isCurrentGeneration()) publish(tabId, result, capture);
      return;
    }
    throw new Error(`layout kept changing during capture (tab ${tabId})`);
  }

  function publish(tabId: number, result: PageThumb[], capture?: CropRequest): void {
    pages.set(tabId, result);
    deps.publish(tabId, result, capture);
  }

  function scan(tabId: number): Promise<void> {
    const generation = generations.get(tabId) ?? 0;
    const task = queue.then(() => scanOnce(tabId, generation));
    queue = task.catch(() => {});
    return task;
  }

  function getPages(tabId: number): PageThumb[] {
    return pages.get(tabId) ?? [];
  }

  /** 停止或關 tab 時呼叫。 */
  function clear(tabId: number): void {
    generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
    pages.delete(tabId);
    deps.publish(tabId, []);
  }

  return { scan, getPages, clear };
}
