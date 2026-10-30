/**
 * 翻譯模式（spec #86）：全域設定，Hosted Translation（送到 Naruhodo 的 Worker）或 Own API Key（讀者自己的 key 直接打 Anthropic）。
 * 由讀者明確選，不會自動切換。存在 chrome.storage.local；SW 每次排 LLM 工作前讀，side panel 的設定區讀寫。
 *
 * 還沒有值時是 Own API Key：#90 還沒有登入與 onboarding。全新安裝預設 Hosted Translation、
 * 從舊版更新沿用 Own API Key 的規則由 onboarding（#93）決定。
 */
export type TranslationMode = 'hosted' | 'ownKey';

export const DEFAULT_TRANSLATION_MODE: TranslationMode = 'ownKey';

const KEY = 'translationMode';

const parse = (value: unknown): TranslationMode => (value === 'hosted' ? 'hosted' : DEFAULT_TRANSLATION_MODE);

export async function loadTranslationMode(): Promise<TranslationMode> {
  const stored = await chrome.storage.local.get(KEY);
  return parse(stored[KEY]);
}

export function saveTranslationMode(mode: TranslationMode): Promise<void> {
  return chrome.storage.local.set({ [KEY]: mode });
}

/** 先讀一次目前的值，之後每次變更都呼叫 onChange；回傳取消監聽。 */
export function watchTranslationMode(onChange: (mode: TranslationMode) => void): () => void {
  let stopped = false;
  const loaded = loadTranslationMode().then((mode) => {
    if (!stopped) onChange(mode);
  });
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(KEY in changes)) return;
    const mode = parse(changes[KEY]!.newValue);
    // 排在初始讀取後面，讀取比變更晚回來也不會被舊值蓋掉
    void loaded.then(() => {
      if (!stopped) onChange(mode);
    });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    stopped = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}
