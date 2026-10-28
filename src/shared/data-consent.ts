/**
 * 資料使用同意（Web Store 2026-08 起的 prominent disclosure 規定，見 docs/research/chrome-web-store-listing.md 第 3 節）：
 * 把文字送到 Anthropic 之前，side panel 要先說明並取得同意。沒同意時 SW 當作沒有 key，不排 LLM 工作。
 *
 * 存在 chrome.storage.local，值是使用者同意的政策版本。資料處理方式改變時把 DATA_CONSENT_VERSION 加一，
 * 舊的同意就失效，side panel 會再問一次（政策要求資料處理改變時主動告知）。
 */
export const DATA_CONSENT_VERSION = 1;

const KEY = 'dataConsent';

const consented = (value: unknown) => value === DATA_CONSENT_VERSION;

export async function hasDataConsent(): Promise<boolean> {
  const stored = await chrome.storage.local.get(KEY);
  return consented(stored[KEY]);
}

export function grantDataConsent(): Promise<void> {
  return chrome.storage.local.set({ [KEY]: DATA_CONSENT_VERSION });
}

export function revokeDataConsent(): Promise<void> {
  return chrome.storage.local.remove(KEY);
}

/** 先讀一次目前的值，之後每次變更都呼叫 onChange；回傳取消監聽。 */
export function watchDataConsent(onChange: (consented: boolean) => void): () => void {
  let stopped = false;
  const loaded = hasDataConsent().then((value) => {
    if (!stopped) onChange(value);
  });
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(KEY in changes)) return;
    const value = consented(changes[KEY]!.newValue);
    // 排在初始讀取後面，讀取比變更晚回來也不會被舊值蓋掉
    void loaded.then(() => {
      if (!stopped) onChange(value);
    });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    stopped = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}
