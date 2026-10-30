import type { Quota } from '../shared/hosted-api.ts';
import type { PageView } from '../shared/messages.ts';
import type { TranslationMode } from '../shared/translation-mode.ts';

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

/**
 * 「已翻譯」或「快取」・模型・秒數・費用（spec #27 第 8 節）；快取時是當初翻譯的模型與數字。翻好、沒在重翻也沒失敗才顯示。
 * 內建翻譯不顯示模型與費用（#92 畫面定案），只有秒數。
 */
function translationStatus({ transcript }: PageView, mode: TranslationMode): string | undefined {
  if (transcript.state !== 'done' || !transcript.translation || transcript.translating || transcript.translateError) return undefined;
  const { source, model, latencyMs, usage } = transcript.translation;
  const label = source === 'cache' ? '快取' : '已翻譯';
  if (mode === 'hosted') return `${label}・${seconds(latencyMs)}`;
  return `${label}・${model}・${seconds(latencyMs)}・$${usage.costUsd.toFixed(4)}`;
}

const dollars = (usd: number) => (Number.isNaN(usd) ? '費用未知' : `$${usd.toFixed(5)}`);

/** 底部狀態列（spec #27 第 8 節）：已翻譯・模型・秒數・費用。多個 Page 時加總。內建翻譯不顯示模型與費用。 */
function overallStatus(pages: PageView[], mode: TranslationMode): OverallStatus {
  const done = pages.flatMap((p) => (p.transcript.state === 'done' ? [p.transcript] : []));
  if (done.some((t) => t.translating)) return { kind: 'translating' };
  const infos = done.flatMap((t) => (t.translated && t.translation ? [t.translation] : []));
  if (infos.length === 0) return undefined;
  // 這頁的提示在逐字稿上方；狀態列只說有更新（#38）
  const notesUpdated = done.some((t) => t.stale === 'notes');
  const models = [...new Set(infos.map((i) => i.model))].join('、');
  const latency = infos.reduce((sum, i) => sum + i.latencyMs, 0);
  const cost = infos.reduce((sum, i) => sum + i.usage.costUsd, 0);
  const prefix = `${notesUpdated ? 'Series Notes 已更新 · ' : ''}已翻譯 ${infos.length} 頁`;
  const text = mode === 'hosted' ? `${prefix} · ${seconds(latency)}` : `${prefix} · ${models} · ${seconds(latency)} · ${dollars(cost)}`;
  return { kind: 'summary', text };
}

export function sidePanelView(pages: PageView[], mode: TranslationMode): SidePanelView {
  return {
    pages: readingOrder(pages).map(({ page, side }, i) => ({
      page,
      side,
      heading: heading(side, i + 1),
      translationStatus: translationStatus(page, mode),
    })),
    status: overallStatus(pages, mode),
  };
}

/** 能不能翻譯取決於翻譯模式（spec #86）：內建翻譯看有沒有登入，自備金鑰看有沒有 key。 */
export type TranslationAccess = { mode: 'hosted'; signedIn: boolean } | { mode: 'ownKey'; hasKey: boolean };

/**
 * 逐字稿上方的提示：signedOut＝「尚未登入」（內建翻譯），noKey＝「尚未設定 API key」（自備金鑰），
 * hostedHint＝「現在也可以改用內建翻譯」（從舊版更新、仍用自備金鑰，只出現一次，#93）。
 */
export type SetupNotice = 'signedOut' | 'noKey' | 'hostedHint' | undefined;

/**
 * 翻譯前的設定提示（#91）。同意依翻譯模式各自記（shared/data-consent.ts），consented 是目前模式的。
 * 自備金鑰用說明卡問；內建翻譯的同意在登入時取得（按「同意並寄送驗證碼」），所以有 token 但同意失效時也算「尚未登入」。
 * consented 還在讀（undefined）時什麼都不顯示。
 */
export function setupNotices({
  access,
  consented,
  untranslated,
  hostedHint = false,
}: {
  access: TranslationAccess;
  consented: boolean | undefined;
  /** 有沒翻譯的頁（自備金鑰的提示只在這時出現）。 */
  untranslated: boolean;
  /** 內建翻譯提示還沒關掉。 */
  hostedHint?: boolean;
}): { consentCard: boolean; notice: SetupNotice } {
  if (consented === undefined) return { consentCard: false, notice: undefined };
  if (access.mode === 'hosted') return { consentCard: false, notice: access.signedIn && consented ? undefined : 'signedOut' };
  const notice = untranslated && !access.hasKey ? 'noKey' : hostedHint ? 'hostedHint' : undefined;
  return { consentCard: !consented, notice };
}

/** 從 ⚙ 選單打開、整個取代 side panel 內容的一頁（頂部是「← 返回」＋標題，#93）。 */
export type PanelPage = 'settings' | 'notes';

/** side panel 這時顯示哪一個畫面：沒做完 onboarding 時只有「完成設定」（沒有頂部的狀態與 ⚙）。 */
export function sidePanelScreen({ setupComplete, page }: { setupComplete: boolean; page: PanelPage | undefined }): 'finishSetup' | 'transcript' | PanelPage {
  if (!setupComplete) return 'finishSetup';
  return page ?? 'transcript';
}

/** 剩這麼多頁以下，底部那一行改用警告色（不另外跳 Callout）。 */
const LOW_QUOTA = 5;

/** 內建翻譯的額度在 side panel 上怎麼顯示（#92 畫面定案）。 */
export interface QuotaView {
  /** 底部狀態列（系列與翻譯狀態之間）多的那一行；subscribeLink＝右邊的「訂閱」小字連結。undefined＝不顯示。 */
  line: { text: string; warn: boolean; subscribeLink: boolean } | undefined;
  /** 額度用完的原因：逐字稿上方顯示用完的 Callout（訂閱＋使用自備金鑰）。undefined＝還能翻。 */
  exhausted: 'freePagesExhausted' | undefined;
  /** 底部的「翻譯此頁／重新翻譯」換成 primary「訂閱」。 */
  subscribeButton: boolean;
}

/**
 * 依翻譯模式、登入與 Worker 回傳的額度（GET /v1/account）算出要顯示什麼。只有內建翻譯、已登入、讀到額度時才有東西；
 * 數字一律是 Worker 給的，這裡不自己扣。
 */
export function quotaView(access: TranslationAccess, quota: Quota | undefined): QuotaView {
  if (access.mode !== 'hosted' || !access.signedIn || !quota) return { line: undefined, exhausted: undefined, subscribeButton: false };
  // 沒有訂閱、免費額度是 0（包含訂閱結束後也用完的讀者）就是用完；#94 加上本月額度用完
  if (quota.remaining === 0)
    return { line: { text: '免費額度已用完', warn: true, subscribeLink: false }, exhausted: 'freePagesExhausted', subscribeButton: true };
  return {
    line: { text: `免費額度剩 ${quota.remaining} 頁`, warn: quota.remaining <= LOW_QUOTA, subscribeLink: true },
    exhausted: undefined,
    subscribeButton: false,
  };
}
