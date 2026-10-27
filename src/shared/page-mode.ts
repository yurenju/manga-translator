/**
 * Page Mode（spec #70、#73）：全域設定，頁面上顯示譯文（閱讀）或保留日文原稿、靠 tooltip 看讀音（學習）。
 * 存在 chrome.storage.local：所有分頁共用、重開瀏覽器也記得。side panel 與 content script 都直接讀寫、
 * 直接監聽變更，不經過 SW；切換時已啟動的分頁靠 storage.onChanged 立刻跟著變。
 */
export type PageMode = 'read' | 'learn';

export const DEFAULT_PAGE_MODE: PageMode = 'read';

const KEY = 'pageMode';

const parse = (value: unknown): PageMode => (value === 'learn' ? 'learn' : DEFAULT_PAGE_MODE);

export async function loadPageMode(): Promise<PageMode> {
  const stored = await chrome.storage.local.get(KEY);
  return parse(stored[KEY]);
}

export function savePageMode(mode: PageMode): Promise<void> {
  return chrome.storage.local.set({ [KEY]: mode });
}

/** 先讀一次目前的值，之後每次變更都呼叫 onChange；回傳取消監聽。 */
export function watchPageMode(onChange: (mode: PageMode) => void): () => void {
  let stopped = false;
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && KEY in changes) onChange(parse(changes[KEY]!.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  void loadPageMode().then((mode) => {
    if (!stopped) onChange(mode);
  });
  return () => {
    stopped = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}
