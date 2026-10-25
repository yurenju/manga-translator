/**
 * 擷取到 Page 之後：本機流水線（offscreen）→ Translator（有的話）→ side panel 逐字稿（spec #27 第 3 節）。
 * 沒有 Translator（沒有 API key）時只顯示 OCR 原文＋kuromoji 讀音、標「未翻譯」（spec 第 5 節）。
 * 快取（#33）、佇列與優先順序（#34）之後才做；現在每次擷取都整批重做，新的擷取取代舊的。
 */
import type { AnalyzeRequest, CropRequest, PageThumb, PageView } from '../shared/messages.ts';
import type { PageText } from '../shared/page-text.ts';
import type { TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';

export interface TranscriberDeps {
  analyze(request: AnalyzeRequest): Promise<PageText>;
  /** 沒有 API key 時回傳 undefined。 */
  getTranslator(): Translator | undefined;
  publish(tabId: number, pages: PageView[]): void;
}

function toTranslateInput(text: PageText): TranslateInput {
  const items = [
    ...text.balloons.map((b) => ({ order: b.order, item: { id: b.id, kind: 'balloon' as const, 原文: b.原文, orientation: b.orientation } })),
    ...text.looseText.map((l) => ({ order: l.order, item: { id: l.id, kind: 'loose' as const, 原文: l.原文, orientation: l.orientation } })),
  ];
  // TODO(#37)：Series Notes 由之後的 ticket 接上
  return { seriesNotes: [], items: items.sort((a, b) => a.order - b.order).map((i) => i.item) };
}

function applyTranslation(text: PageText, output: TranslateOutput): PageText {
  const byId = new Map(output.items.map((item) => [item.id, item]));
  const merge = <T extends { id: string; 讀音: string; 讀音來源: 'llm' | 'kuromoji'; 譯文: string; unreadable: boolean }>(entry: T): T => {
    const item = byId.get(entry.id);
    return item ? { ...entry, 讀音: item.讀音, 讀音來源: 'llm', 譯文: item.譯文, unreadable: item.unreadable } : entry;
  };
  return { balloons: text.balloons.map(merge), looseText: text.looseText.map(merge) };
}

export function createTranscriber(deps: TranscriberDeps) {
  const views = new Map<number, PageView[]>();
  /** 每次 update／clear 加一；做完時不同就丟掉結果。 */
  const versions = new Map<number, number>();

  async function transcribe(request: AnalyzeRequest): Promise<PageView['transcript']> {
    let text: PageText;
    try {
      text = await deps.analyze(request);
    } catch (e) {
      return { state: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    const translator = deps.getTranslator();
    if (!translator) return { state: 'done', text, translated: false };
    try {
      return { state: 'done', text: applyTranslation(text, await translator.translatePage(toTranslateInput(text))), translated: true };
    } catch (e) {
      // 重試與「重試」按鈕在 #31；這裡先退回 kuromoji 讀音
      console.warn('translate failed', e);
      return { state: 'done', text, translated: false };
    }
  }

  async function update(tabId: number, pages: PageThumb[], capture: CropRequest): Promise<void> {
    const version = (versions.get(tabId) ?? 0) + 1;
    versions.set(tabId, version);
    const current: PageView[] = pages.map((page) => ({ ...page, transcript: { state: 'analyzing' } }));
    views.set(tabId, current);
    deps.publish(tabId, current);
    for (const [i, page] of pages.entries()) {
      const transcript = await transcribe({ screenshot: capture.screenshot, viewport: capture.viewport, candidate: page });
      if (versions.get(tabId) !== version) return;
      current[i] = { ...current[i]!, transcript };
      deps.publish(tabId, [...current]);
    }
  }

  function get(tabId: number): PageView[] {
    return views.get(tabId) ?? [];
  }

  function clear(tabId: number): void {
    versions.set(tabId, (versions.get(tabId) ?? 0) + 1);
    views.delete(tabId);
    deps.publish(tabId, []);
  }

  return { update, get, clear };
}
