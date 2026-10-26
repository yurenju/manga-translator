import type { Series } from '../shared/series.ts';

/**
 * 啟動時沒有預選到 Series 就建一個 Provisional Series（spec #27 第 4.1 節），每次這樣的啟動各一個。
 * 名稱例：「未命名・shonenjumpplus.com・10/25」。
 */
export function provisionalSeries(url: string, now: Date, id: string): Series {
  const date = `${now.getMonth() + 1}/${now.getDate()}`;
  return { id, name: `未命名・${new URL(url).hostname}・${date}`, provisional: true, createdAt: now.getTime() };
}
