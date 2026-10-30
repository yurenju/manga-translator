import type { Locale } from './locale.ts';

const KEY = 'naruhodo.locale';

/** 讀者在頁首手動切換過的語言；隱私模式或封鎖儲存時 localStorage 會丟例外，當作沒選過。 */
export function readSavedLocale(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // 存不了就只對這次瀏覽有效
  }
}
