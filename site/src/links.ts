import type { Locale } from './locale.ts';

export const REPO_URL = 'https://github.com/yurenju/naruhodo-manga-translator';

/** 「加到 Chrome」：外掛還沒有公開的 Chrome Web Store 網址，先指到 README 的安裝說明。 */
export const INSTALL_URL = `${REPO_URL}#安裝`;

export const LEGAL_DOCS = ['terms', 'refund', 'privacy'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** 法律文件一律英文、只有一個網址；`?lang=` 讓頁首頁尾跟著讀者剛才在看的語言。 */
export function legalHref(doc: LegalDoc, locale: Locale): string {
  return `/${doc}?lang=${locale}`;
}
