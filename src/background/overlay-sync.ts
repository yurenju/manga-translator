/**
 * 翻好的 Page → content script 原地覆蓋（spec #27 第 3 節最後一步）。
 * 沒有譯文（沒有 API key）時不覆蓋（第 5 節）；unreadable 與 Loose Text 由 content script 略過。
 */
import type { PageView } from '../shared/messages.ts';
import type { PageText } from '../shared/page-text.ts';

/** 一個翻好的 Page 要覆蓋到哪：anchor（元素）＋ pageHash（Page 身分，hover 同步用）。 */
export interface OverlayShow {
  tabId: number;
  anchorId: string;
  pageHash: string;
  text: PageText;
}

export interface OverlaySyncDeps {
  show(show: OverlayShow): void;
}

export function createOverlaySync(deps: OverlaySyncDeps) {
  /** 已經送過的結果；transcriber 每次 publish 都帶整串 Page，同一個物件不重送。 */
  const sent = new WeakSet<PageText>();

  function publish(tabId: number, pages: readonly PageView[]): void {
    for (const page of pages) {
      const { transcript } = page;
      if (transcript.state !== 'done' || !transcript.translated || sent.has(transcript.text)) continue;
      sent.add(transcript.text);
      deps.show({ tabId, anchorId: page.anchorId, pageHash: page.pageHash, text: transcript.text });
    }
  }

  return { publish };
}
