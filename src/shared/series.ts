/** Series（spec #27 第 4.1 節）。網址模式（UrlPattern）在 #36。 */
export interface Series {
  /** 外掛產生的 ID，不是網站的 ID。 */
  id: string;
  name: string;
  /** Provisional Series：下拉選單顯示為「未歸類」；改名就拿掉（#36）。 */
  provisional: boolean;
  createdAt: number;
}
