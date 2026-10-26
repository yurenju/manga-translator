/**
 * 擷取到 Page 之後：本機流水線（offscreen）→ Translator（有的話）→ side panel 逐字稿（spec #27 第 3 節）。
 * 沒有 Translator（沒有 API key）時只顯示 OCR 原文＋kuromoji 讀音、標「未翻譯」（spec 第 5 節）。
 * 翻譯快取（#33）：先查 (Series ID, Page hash)，命中就直接用、不跑本機流水線也不呼叫 Translator；翻譯成功才寫入。
 * 佇列與優先順序（#34）之後才做；現在每次擷取都整批重做，新的擷取取代舊的。
 */
import type { AnalyzeRequest, CropRequest, PageThumb, PageView } from '../shared/messages.ts';
import type { PageText, PageTranslation } from '../shared/page-text.ts';
import type { TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';

export interface PageCache {
  /** 同一個 Series 裡 hash 在門檻內最接近的一筆。 */
  find(seriesId: string, pageHash: string): Promise<PageTranslation | undefined>;
  save(translation: PageTranslation): Promise<void>;
}

export interface TranscriberDeps {
  analyze(request: AnalyzeRequest): Promise<PageText>;
  /** 沒有 API key 時回傳 undefined。 */
  getTranslator(): Translator | undefined;
  /** 這個 tab 啟動時選定的 Series（或 Provisional Series）；沒有就不查也不寫快取。 */
  getSeriesId(tabId: number): Promise<string | undefined>;
  cache: PageCache;
  publish(tabId: number, pages: PageView[]): void;
}

// TODO(#31／#38)：Translator 還沒有 prompt 版本；過時提示要比對它
const PROMPT_VERSION = '';

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

  async function transcribe(request: AnalyzeRequest, seriesId: string | undefined, pageHash: string): Promise<PageView['transcript']> {
    if (seriesId !== undefined) {
      const cached = await deps.cache.find(seriesId, pageHash).catch((e: unknown) => {
        console.warn('cache lookup failed', e);
        return undefined;
      });
      if (cached) {
        const { balloons, looseText, model, latencyMs, usage } = cached;
        return { state: 'done', text: { balloons, looseText }, translated: true, translation: { source: 'cache', model, latencyMs, costUsd: usage.costUsd } };
      }
    }
    let text: PageText;
    try {
      text = await deps.analyze(request);
    } catch (e) {
      return { state: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    const translator = deps.getTranslator();
    if (!translator) return { state: 'done', text, translated: false };
    let output: TranslateOutput;
    try {
      output = await translator.translatePage(toTranslateInput(text));
    } catch (e) {
      // 重試與「重試」按鈕在 #31；這裡先退回 kuromoji 讀音
      console.warn('translate failed', e);
      return { state: 'done', text, translated: false };
    }
    const translated = applyTranslation(text, output);
    if (seriesId !== undefined) {
      const entry: PageTranslation = {
        ...translated,
        seriesId,
        pageHash,
        usedNotes: [],
        model: output.model,
        promptVersion: PROMPT_VERSION,
        usage: output.usage,
        latencyMs: output.latencyMs,
        translatedAt: Date.now(),
      };
      // 寫不進去只是下次要重翻，這次的結果照樣顯示。
      await deps.cache.save(entry).catch((e: unknown) => console.warn('cache save failed', e));
    }
    const { model, latencyMs, usage } = output;
    return { state: 'done', text: translated, translated: true, translation: { source: 'translated', model, latencyMs, costUsd: usage.costUsd } };
  }

  async function update(tabId: number, pages: PageThumb[], capture: CropRequest): Promise<void> {
    const version = (versions.get(tabId) ?? 0) + 1;
    versions.set(tabId, version);
    const current: PageView[] = pages.map((page) => ({ ...page, transcript: { state: 'analyzing' } }));
    views.set(tabId, current);
    deps.publish(tabId, current);
    const seriesId = await deps.getSeriesId(tabId);
    for (const [i, page] of pages.entries()) {
      const candidate = { anchorId: page.anchorId, rect: page.rect };
      const transcript = await transcribe({ screenshot: capture.screenshot, viewport: capture.viewport, candidate }, seriesId, page.pageHash);
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
