/**
 * 翻好的 Page → content script 原地覆蓋（spec #27 第 3 節最後一步）。
 * 沒有譯文（沒有 API key）時不覆蓋（第 5 節）；unreadable 與 Loose Text 由 content script 略過。
 */
import type { PageCandidate, PageView } from '../shared/messages.ts';
import { findSamePage } from '../shared/page-hash.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';

/** 一個翻好的 Page 要覆蓋到哪：anchor（元素）＋ sub（Page 在 anchor 裡的範圍）＋ pageHash（Page 身分，hover 同步用）。 */
export interface OverlayShow {
  tabId: number;
  anchorId: string;
  pageHash: string;
  sub?: RatioRect;
  text: PageText;
}

export interface OverlaySyncDeps {
  show(show: OverlayShow): void;
}

/** 送過的一筆：哪個 anchor 上的哪一頁、送的是哪一份結果。 */
interface Sent {
  anchorId: string;
  pageHash: string;
  text: PageText;
}

export function createOverlaySync(deps: OverlaySyncDeps) {
  /** 每個 tab 送過、應該還顯示著的覆蓋；transcriber 每次 publish 都帶整串 Page，同一份結果不重送。 */
  const sent = new Map<number, Sent[]>();

  const isSamePage = (s: { anchorId: string; pageHash: string }, page: { anchorId: string; pageHash: string }) =>
    s.anchorId === page.anchorId && findSamePage([s], page.pageHash) !== undefined;

  function publish(tabId: number, pages: readonly PageView[]): void {
    const list = sent.get(tabId) ?? [];
    for (const page of pages) {
      const { transcript } = page;
      if (transcript.state !== 'done' || !transcript.translated) continue;
      if (list.some((s) => s.text === transcript.text && isSamePage(s, page))) continue;
      const others = list.filter((s) => !isSamePage(s, page));
      list.splice(0, list.length, ...others, { anchorId: page.anchorId, pageHash: page.pageHash, text: transcript.text });
      deps.show({ tabId, anchorId: page.anchorId, pageHash: page.pageHash, ...(page.sub ? { sub: page.sub } : {}), text: transcript.text });
    }
    sent.set(tabId, list);
  }

  /**
   * 每次擷取後：擷取到的 anchor 只記得上面確實還顯示著的覆蓋（PageCandidate.overlaid）。content script 清掉的
   * （img 換了 src、Kindle 視窗大小變了重新產生合成圖）下次 publish 會重送，同一頁換回來時覆蓋才回得來。
   */
  function captured(tabId: number, pages: readonly PageCandidate[]): void {
    // 這次沒擷取到的 anchor（捲走了）不知道，當作還顯示著
    const shown = (s: Sent) => {
      const onAnchor = pages.filter((p) => p.anchorId === s.anchorId);
      return onAnchor.length === 0 || onAnchor.some((p) => findSamePage((p.overlaid ?? []).map((pageHash) => ({ pageHash })), s.pageHash));
    };
    sent.set(tabId, (sent.get(tabId) ?? []).filter(shown));
  }

  return { publish, captured };
}
