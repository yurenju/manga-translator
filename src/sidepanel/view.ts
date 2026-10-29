import type { PageView } from '../shared/messages.ts';

/** Page 在 Spread 裡的哪一邊；undefined＝不是 Spread。 */
export type SpreadSide = 'right' | 'left';

/** 頁首：單頁是「第 N 頁」；Spread 是「右頁」＋「先讀」。 */
export interface PageHeading {
  title: string;
  order?: string;
}

/** side panel 列出的一個 Page。 */
export interface PageEntry {
  page: PageView;
  side: SpreadSide | undefined;
  heading: PageHeading;
  /** 頁首右側的翻譯狀態；undefined＝不顯示。 */
  translationStatus: string | undefined;
}

/** 底部狀態列：翻譯中、或已翻譯的摘要；undefined＝沒有譯文，不顯示。 */
export type OverallStatus = { kind: 'translating' } | { kind: 'summary'; text: string } | undefined;

/** side panel 該顯示什麼（元件只負責畫出來）。 */
export interface SidePanelView {
  pages: PageEntry[];
  status: OverallStatus;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

const centerX = (page: PageView) => page.subRect && page.subRect.x + page.subRect.w / 2;

type OrderedPage = { page: PageView; side: SpreadSide | undefined };

/**
 * side panel 列 Page 的順序與每頁在 Spread 裡的哪一邊（spec #70）。同一個 anchor 切出兩個 Page 才是 Spread：
 * subRect 中心偏右的是右頁、排在前面（日漫由右往左讀），不依賴 SW 給的順序。只看 subRect 不夠：單頁去黑邊後也有
 * subRect。同一個 anchor 的兩個 Page 分不出左右（沒有 subRect）就不標左右，照 SW 的順序。
 */
function readingOrder(pages: PageView[]): OrderedPage[] {
  const byAnchor = new Map<string, PageView[]>();
  for (const page of pages) byAnchor.set(page.anchorId, [...(byAnchor.get(page.anchorId) ?? []), page]);
  return [...byAnchor.values()].flatMap((group): OrderedPage[] => {
    const [a, b] = group;
    const ax = a && centerX(a);
    const bx = b && centerX(b);
    if (group.length !== 2 || ax === undefined || bx === undefined || ax === bx)
      return group.map((page) => ({ page, side: undefined }));
    const [right, left] = ax > bx ? [a!, b!] : [b!, a!];
    return [
      { page: right, side: 'right' },
      { page: left, side: 'left' },
    ];
  });
}

function heading(side: SpreadSide | undefined, number: number): PageHeading {
  if (side === undefined) return { title: `第 ${number} 頁` };
  return side === 'right' ? { title: '右頁', order: '先讀' } : { title: '左頁', order: '後讀' };
}

/** 「已翻譯」或「快取」・模型・秒數・費用（spec #27 第 8 節）；快取時是當初翻譯的模型與數字。翻好、沒在重翻也沒失敗才顯示。 */
function translationStatus({ transcript }: PageView): string | undefined {
  if (transcript.state !== 'done' || !transcript.translation || transcript.translating || transcript.translateError) return undefined;
  const { source, model, latencyMs, usage } = transcript.translation;
  const label = source === 'cache' ? '快取' : '已翻譯';
  return `${label}・${model}・${seconds(latencyMs)}・$${usage.costUsd.toFixed(4)}`;
}

const dollars = (usd: number) => (Number.isNaN(usd) ? '費用未知' : `$${usd.toFixed(5)}`);

/** 底部狀態列（spec #27 第 8 節）：已翻譯・模型・秒數・費用。多個 Page 時加總。 */
function overallStatus(pages: PageView[]): OverallStatus {
  const done = pages.flatMap((p) => (p.transcript.state === 'done' ? [p.transcript] : []));
  if (done.some((t) => t.translating)) return { kind: 'translating' };
  const infos = done.flatMap((t) => (t.translated && t.translation ? [t.translation] : []));
  if (infos.length === 0) return undefined;
  // 這頁的提示在逐字稿上方；狀態列只說有更新（#38）
  const notesUpdated = done.some((t) => t.stale === 'notes');
  const models = [...new Set(infos.map((i) => i.model))].join('、');
  const latency = infos.reduce((sum, i) => sum + i.latencyMs, 0);
  const cost = infos.reduce((sum, i) => sum + i.usage.costUsd, 0);
  const text = `${notesUpdated ? 'Series Notes 已更新 · ' : ''}已翻譯 ${infos.length} 頁 · ${models} · ${seconds(latency)} · ${dollars(cost)}`;
  return { kind: 'summary', text };
}

export function sidePanelView(pages: PageView[]): SidePanelView {
  return {
    pages: readingOrder(pages).map(({ page, side }, i) => ({
      page,
      side,
      heading: heading(side, i + 1),
      translationStatus: translationStatus(page),
    })),
    status: overallStatus(pages),
  };
}
