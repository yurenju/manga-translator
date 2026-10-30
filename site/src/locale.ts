/** 網站的語系，也是網址的路徑前綴（`/zh-tw/…`、`/en/…`）。 */
export type Locale = 'zh-tw' | 'en';

/** 瀏覽器語系標籤（`zh-CN`、`en-GB`…）對應到網站語系；中文只有繁體版，所以所有 `zh-*` 都用繁中。 */
function fromLanguageTag(tag: string): Locale | undefined {
  const primary = tag.toLowerCase().split('-')[0];
  if (primary === 'zh') return 'zh-tw';
  if (primary === 'en') return 'en';
  return undefined;
}

export const LOCALES: readonly Locale[] = ['zh-tw', 'en'];

/** `<html lang>` 用的 BCP 47 語言標籤。 */
export function languageTag(locale: Locale): string {
  return locale === 'zh-tw' ? 'zh-Hant' : 'en';
}

/** 對每個語系各算一次，例如語言切換與法律文件連結的網址。 */
export function byLocale<T>(fn: (locale: Locale) => T): Record<Locale, T> {
  return { 'zh-tw': fn('zh-tw'), en: fn('en') };
}

export function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}

/**
 * 讀者看到的語言：連結帶來的語言（`requested`）> 手動切換存下的選擇（`saved`）> 瀏覽器偏好的語系順序 > 英文。
 * `requested` 是法律文件網址的 `?lang=`：文件只有一個網址，頁首頁尾跟著讀者剛才在看的語言。
 * 兩者都來自網址或 localStorage，可能是舊版或被改過的值，不是網站語系就當作沒有。
 */
export function pickLocale(input: {
  requested?: string | null;
  saved?: string | null;
  browserLanguages: readonly string[];
}): Locale {
  if (isLocale(input.requested)) return input.requested;
  if (isLocale(input.saved)) return input.saved;
  for (const tag of input.browserLanguages) {
    const locale = fromLanguageTag(tag);
    if (locale) return locale;
  }
  return 'en';
}
