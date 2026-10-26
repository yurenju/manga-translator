/**
 * 翻好的 Page → content script 原地覆蓋（spec #27 第 3 節最後一步）。
 * 沒有譯文（沒有 API key）時不覆蓋（第 5 節）；unreadable 與 Loose Text 由 content script 略過。
 */
import type { PageView } from '../shared/messages.ts';
import type { PageText } from '../shared/page-text.ts';

export interface OverlaySyncDeps {
  show(tabId: number, anchorId: string, text: PageText): void;
}

export function createOverlaySync(deps: OverlaySyncDeps) {
  /** 已經送過的結果；transcriber 每次 publish 都帶整串 Page，同一個物件不重送。 */
  const sent = new WeakSet<PageText>();

  function publish(tabId: number, pages: readonly PageView[]): void {
    for (const page of pages) {
      const { transcript } = page;
      if (transcript.state !== 'done' || !transcript.translated || sent.has(transcript.text)) continue;
      sent.add(transcript.text);
      deps.show(tabId, page.anchorId, transcript.text);
    }
  }

  return { publish };
}
