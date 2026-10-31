import { findSamePage } from '../shared/page-hash.ts';
import type { PageTranslation } from '../shared/page-text.ts';
import type { Series, SeriesOption, UrlPattern } from '../shared/series.ts';

/**
 * 啟動時沒有預選到 Series 就建一個 Provisional Series（spec #27 第 4.1 節），每次這樣的啟動各一個。
 * 名稱例：「未命名・manga.example・10/25」。
 */
export function provisionalSeries(url: string, now: Date, id: string): Series {
  const date = `${now.getMonth() + 1}/${now.getDate()}`;
  return { id, name: `未命名・${new URL(url).hostname}・${date}`, provisional: true, createdAt: now.getTime() };
}

/**
 * 網址模式＝完整網址比對（spec #27 第 4.1 節，選項 A）：只留 origin＋path。
 * 不做路徑前綴比對，也不做「這個網站上次用的 Series」。
 */
export function urlPattern(url: string): string {
  const { origin, pathname } = new URL(url);
  return origin + pathname;
}

/**
 * 合併時要寫進目標 Series 的快取：來源的每一筆改用目標 ID；同一個 Page（hash 在門檻內）
 * 目標已經有的就保留目標原本的那份，不寫。
 */
export function mergeTranslations(target: readonly PageTranslation[], source: readonly PageTranslation[], targetId: string): PageTranslation[] {
  return source.filter((t) => !findSamePage(target, t.pageHash)).map((t) => ({ ...t, seriesId: targetId }));
}

/** Series 下拉選單：最近用過的（網址模式的 lastUsedAt）在最上面，沒用過的依建立時間新到舊。 */
export function seriesMenu(series: readonly Series[], patterns: readonly UrlPattern[]): SeriesOption[] {
  const lastUsed = new Map<string, number>();
  for (const p of patterns) lastUsed.set(p.seriesId, Math.max(lastUsed.get(p.seriesId) ?? 0, p.lastUsedAt));
  return [...series]
    .sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0) || b.createdAt - a.createdAt)
    .map((s) => ({ ...s, label: s.provisional ? `未歸類（${s.name}）` : s.name }));
}
