/**
 * debug:eval 的純邏輯（scripts/debug-eval.ts）：從 debug Chrome 的 /json/list 挑出要執行程式的 target，
 * 以及把使用者的程式包成 Runtime.evaluate 的 expression。
 */

/** http://127.0.0.1:<port>/json/list 的一筆。 */
export interface TargetInfo {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * sw：外掛的 service worker；offscreen：offscreen document；page：漫畫分頁的 main world；
 * content：漫畫分頁裡 content script 的 isolated world。
 */
export const CONTEXTS = ['sw', 'offscreen', 'page', 'content'] as const;
export type Context = (typeof CONTEXTS)[number];

export const isContext = (value: string | undefined): value is Context => (CONTEXTS as readonly string[]).includes(value ?? '');

/** debug build 叫「Naruhodo (debug)」，正式版叫「Naruhodo」。 */
export const isOurExtension = (name: unknown): boolean => typeof name === 'string' && name.startsWith('Naruhodo');

/**
 * 可能是目標的 target，照 /json/list 的順序（最近用過的在前）。
 * sw／offscreen：profile 裡別的外掛也有叫 background.js 的 SW、也可能有 offscreen.html，呼叫端要再用 manifest 名稱（isOurExtension）挑。
 * page／content：一般網頁分頁；urlFilter 給了就只留 url 含這段字的。
 */
export function candidateTargets(targets: readonly TargetInfo[], context: Context, urlFilter?: string): TargetInfo[] {
  return targets.filter((target) => {
    if (target.webSocketDebuggerUrl === undefined) return false;
    if (context === 'sw') return target.type === 'service_worker' && target.url.startsWith('chrome-extension://');
    if (context === 'offscreen') return target.url.startsWith('chrome-extension://') && new URL(target.url).pathname.endsWith('/offscreen.html');
    return target.type === 'page' && /^https?:/.test(target.url) && (urlFilter === undefined || target.url.includes(urlFilter));
  });
}

/**
 * SW 裡先定義的小工具。正式 build 沒有 tabs 權限，chrome.tabs.query 拿得到分頁但看不到 url（debug build 有 <all_urls>，看得到）；
 * 漫畫分頁（有 activeTab 的那個）就是最後聚焦視窗的作用中分頁。
 */
const SW_PRELUDE = 'const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];';

/**
 * 把一段可 await 的運算式包成 async IIFE（Runtime.evaluate 搭配 awaitPromise 等它）。
 * 多個敘述就自己包一層 (async () => { ...; return x; })()。結尾的分號會拿掉，才能放進括號裡。
 */
export function buildExpression(code: string, context: Context): string {
  const body = code.trim().replace(/;+$/, '');
  if (body === '') throw new Error('沒有要執行的程式');
  const prelude = context === 'sw' ? `${SW_PRELUDE}\n` : '';
  return `(async () => {\n${prelude}return (\n${body}\n);\n})()`;
}

/** chrome.tabs.query 的一筆，只留挑分頁要用的欄位（debug build 有 <all_urls>，看得到 url）。 */
export interface ChromeTab {
  id: number;
  url: string;
  active: boolean;
  windowId: number;
}

const isWebPage = (tab: ChromeTab) => /^https?:/.test(tab.url);

/**
 * debug:panel／debug:activate 要操作的漫畫分頁（scripts/debug-drive.ts）。
 * 給了 urlFilter：第一個 url 含它的網頁分頁。沒給：最後聚焦視窗的作用中分頁；
 * 那個視窗沒有網頁（例如剛聚焦的是 side panel 視窗）就退回任一視窗的作用中網頁分頁。
 */
export function pickMangaTab(tabs: readonly ChromeTab[], lastFocusedWindowId: number | undefined, urlFilter?: string): ChromeTab | undefined {
  const pages = tabs.filter(isWebPage);
  if (urlFilter !== undefined) return pages.find((tab) => tab.url.includes(urlFilter));
  const active = pages.filter((tab) => tab.active);
  return active.find((tab) => tab.windowId === lastFocusedWindowId) ?? active[0];
}

/** 這個分頁專屬的 side panel（sidepanel.html?tabId=N），已經開著就沿用，不再開一個。 */
export function panelTarget(targets: readonly TargetInfo[], tabId: number): TargetInfo | undefined {
  return targets.find((target) => {
    if (!target.url.startsWith('chrome-extension://')) return false;
    const url = new URL(target.url);
    return url.pathname.endsWith('/sidepanel.html') && url.searchParams.get('tabId') === String(tabId);
  });
}
