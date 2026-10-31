import type { Locale } from './locale.ts';

export const REPO_URL = 'https://github.com/yurenju/naruhodo-manga-translator';

/** 「加到 Chrome」：外掛還沒有公開的 Chrome Web Store 網址，先指到 README 的安裝說明。 */
export const INSTALL_URL = `${REPO_URL}#安裝`;

/** 聯絡 email（TERMS.md 第 14 節）：Paddle 審核網站時要在首頁找得到聯絡方式。 */
export const CONTACT_EMAIL = 'dev@sadcoder.com';

export const LEGAL_DOCS =['terms', 'refund', 'privacy'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** 法律文件一律英文、只有一個網址；`?lang=` 讓頁首頁尾跟著讀者剛才在看的語言。 */
export function legalHref(doc: LegalDoc, locale: Locale): string {
  return `/${doc}?lang=${locale}`;
}
