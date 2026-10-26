/** Series 與網址模式（spec #27 第 4.1 節）。 */
export interface Series {
  /** 外掛產生的 ID，不是網站的 ID。 */
  id: string;
  name: string;
  /** Provisional Series：下拉選單顯示為「未歸類」；改名就拿掉，ID 不變（#36）。 */
  provisional: boolean;
  createdAt: number;
}

/**
 * 網址模式：完整網址（origin＋path，忽略 query 與 hash）對應到一個 Series。一個 Series 可以有很多條；
 * 只在歸類（選定非 Provisional 的 Series）之後才記住。
 */
export interface UrlPattern {
  pattern: string;
  seriesId: string;
  lastUsedAt: number;
}

/** side panel 的 Series 下拉選單的一項，已排好順序（最近用過的在最上面）。 */
export interface SeriesOption extends Series {
  /** 下拉選單顯示的文字；Provisional Series 是「未歸類（名稱）」。 */
  label: string;
}
