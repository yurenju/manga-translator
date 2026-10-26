/**
 * 翻頁偵測的前半段（spec #27 第 3.2 節）：DOM mutation／scroll／resize／按鍵／點擊／img load
 * → debounce → 通知 SW 截圖。真的有沒有翻頁由 SW 比對每個 Page 的 hash 決定。不做定時輪詢。
 */

/** 事件停下這麼久才截圖：翻頁動畫（仿 Jump+ 450 ms，結束時有 transitionend）跑完、捲動停下。 */
export const PAGE_TURN_DEBOUNCE_MS = 400;

export interface PageTurnSignalDeps {
  notify(): void;
  delayMs?: number;
}

export function createPageTurnSignal({ notify, delayMs = PAGE_TURN_DEBOUNCE_MS }: PageTurnSignalDeps) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  return {
    fire(): void {
      if (cancelled) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        notify();
      }, delayMs);
    },
    cancel(): void {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

const EVENTS = ['scroll', 'keydown', 'click', 'load', 'transitionend', 'animationend'] as const;

type Listeners = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface PageTurnWatchDeps extends PageTurnSignalDeps {
  /**
   * 自己造成的變動：覆蓋層（shadow host）的插入、截圖前後切換 visibility，以及覆蓋層把父元素改成
   * relative（attribute＝'style'）。這些不算翻頁，不然每次覆蓋或截圖都會再觸發一次截圖。
   */
  isOwn(node: Node, attribute?: string): boolean;
  /** 頁面的 document：事件用 capture 掛在它上面，MutationObserver 看 documentElement。 */
  document: Listeners & { documentElement: Node };
  /** resize 掛在 window 上。 */
  window: Listeners;
  MutationObserver: new (callback: MutationCallback) => Pick<MutationObserver, 'observe' | 'disconnect'>;
}

/** 掛上所有翻頁訊號，回傳拆掉的函式。 */
export function watchPageTurns(deps: PageTurnWatchDeps): () => void {
  const { isOwn, document, window } = deps;
  const signal = createPageTurnSignal(deps);
  const onEvent = () => signal.fire();
  // capture：scroll 與 load 不會冒泡，capture 才收得到頁面內任何元素的
  for (const type of EVENTS) document.addEventListener(type, onEvent, { capture: true, passive: true });
  window.addEventListener('resize', onEvent);
  const observer = new deps.MutationObserver((records) => {
    const foreign = (r: MutationRecord) =>
      r.type === 'childList' ? [...r.addedNodes, ...r.removedNodes].some((n) => !isOwn(n)) : !isOwn(r.target, r.attributeName ?? undefined);
    if (records.some(foreign)) signal.fire();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class'] });
  return () => {
    signal.cancel();
    observer.disconnect();
    for (const type of EVENTS) document.removeEventListener(type, onEvent, { capture: true });
    window.removeEventListener('resize', onEvent);
  };
}
