/** chrome.storage.local 裡一個值的監聽：side panel 與 SW 跟著設定變更（翻譯模式、onboarding 進度）。 */

/** 先讀一次目前的值，之後每次變更都呼叫 onChange；回傳取消監聽。 */
export function watchLocal<T>(key: string, parse: (value: unknown) => T, onChange: (value: T) => void): () => void {
  let stopped = false;
  const loaded = chrome.storage.local.get(key).then((stored) => {
    if (!stopped) onChange(parse(stored[key]));
  });
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(key in changes)) return;
    const value = parse(changes[key]!.newValue);
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
