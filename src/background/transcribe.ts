/**
 * 擷取到 Page 之後：本機流水線（offscreen）→ Translator（有的話）→ side panel 逐字稿（spec #27 第 3 節）。
 * 沒有 Translator（沒有 API key）時只顯示 OCR 原文＋kuromoji 讀音、標「未翻譯」（spec 第 5 節）；
 * 翻譯失敗時也退回 kuromoji 讀音，並帶上錯誤訊息。設定 key 之後按「翻譯此頁」用同一份辨識結果重新翻譯。
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
  getTranslator(): Translator | undefined | Promise<Translator | undefined>;
  /** 這個 tab 啟動時選定的 Series（或 Provisional Series）；沒有就不查也不寫快取。 */
  getSeriesId(tabId: number): Promise<string | undefined>;
  cache: PageCache;
  publish(tabId: number, pages: PageView[]): void;
}

type Transcript = PageView['transcript'];

// TODO(#38)：Translator 的 prompt 版本（offscreen/claude-translator.ts 的 PROMPT_VERSION）還沒傳到 SW；過時提示要比對它
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

/** 翻譯成功後寫進快取的位置；沒有 Series 時不寫。 */
interface CacheTarget {
  seriesId: string | undefined;
  pageHash: string;
}

/** text 是本機流水線的結果（kuromoji 讀音）；失敗時就顯示它。只有翻譯成功才寫快取。 */
async function translateText(text: PageText, translator: Translator | undefined, cache: PageCache, target: CacheTarget): Promise<Transcript> {
  if (!translator) return { state: 'done', text, translated: false };
  let output: TranslateOutput;
  try {
    output = await translator.translatePage(toTranslateInput(text));
  } catch (e) {
    // 429／5xx 的重試在 Translator 裡（claude-translator.ts）；這裡是重試後仍失敗
    console.warn('translate failed', e);
    return { state: 'done', text, translated: false, translateError: e instanceof Error ? e.message : String(e) };
  }
  const translated = applyTranslation(text, output);
  const { model, latencyMs, usage } = output;
  if (target.seriesId !== undefined) {
    const entry: PageTranslation = {
      ...translated,
      seriesId: target.seriesId,
      pageHash: target.pageHash,
      usedNotes: [],
      model,
      promptVersion: PROMPT_VERSION,
      usage,
      latencyMs,
      translatedAt: Date.now(),
    };
    // 寫不進去只是下次要重翻，這次的結果照樣顯示。
    await cache.save(entry).catch((e: unknown) => console.warn('cache save failed', e));
  }
  return { state: 'done', text: translated, translated: true, translation: { source: 'translated', model, latencyMs, usage } };
}

export function createTranscriber(deps: TranscriberDeps) {
  const views = new Map<number, PageView[]>();
  /** 每個 Page 本機流水線的結果，「翻譯此頁」用它重新翻譯，不必重跑 OCR。 */
  const analyzed = new Map<number, (PageText | undefined)[]>();
  /** 每次 update／clear 加一；做完時不同就丟掉結果。 */
  const versions = new Map<number, number>();
  /** 每次 translate 加一：連按兩次時只留最後一次的結果。 */
  const translateRuns = new Map<number, number>();

  async function transcribe(request: AnalyzeRequest, target: CacheTarget): Promise<{ transcript: Transcript; text?: PageText }> {
    if (target.seriesId !== undefined) {
      const cached = await deps.cache.find(target.seriesId, target.pageHash).catch((e: unknown) => {
        console.warn('cache lookup failed', e);
        return undefined;
      });
      if (cached) {
        const { balloons, looseText, model, latencyMs, usage } = cached;
        // 命中快取時沒有本機流水線的結果（text），「翻譯此頁／重新翻譯」不會重翻這頁。
        return { transcript: { state: 'done', text: { balloons, looseText }, translated: true, translation: { source: 'cache', model, latencyMs, usage } } };
      }
    }
    let text: PageText;
    try {
      text = await deps.analyze(request);
    } catch (e) {
      return { transcript: { state: 'error', message: e instanceof Error ? e.message : String(e) } };
    }
    return { transcript: await translateText(text, await deps.getTranslator(), deps.cache, target), text };
  }

  async function update(tabId: number, pages: PageThumb[], capture: CropRequest): Promise<void> {
    const version = (versions.get(tabId) ?? 0) + 1;
    versions.set(tabId, version);
    const current: PageView[] = pages.map((page) => ({ ...page, transcript: { state: 'analyzing' } }));
    const texts: (PageText | undefined)[] = pages.map(() => undefined);
    views.set(tabId, current);
    analyzed.set(tabId, texts);
    deps.publish(tabId, current);
    const seriesId = await deps.getSeriesId(tabId);
    for (const [i, page] of pages.entries()) {
      const candidate = { anchorId: page.anchorId, rect: page.rect };
      const { transcript, text } = await transcribe(
        { screenshot: capture.screenshot, viewport: capture.viewport, candidate },
        { seriesId, pageHash: page.pageHash },
      );
      if (versions.get(tabId) !== version) return;
      texts[i] = text;
      current[i] = { ...current[i]!, transcript };
      deps.publish(tabId, [...current]);
    }
  }

  /** 「翻譯此頁／重新翻譯」：已辨識完的 Page 全部重新翻譯。沒有 key 時什麼都不做。 */
  async function translate(tabId: number): Promise<void> {
    const translator = await deps.getTranslator();
    const current = views.get(tabId);
    const texts = analyzed.get(tabId);
    if (!translator || !current || !texts) return;
    const version = versions.get(tabId);
    const run = (translateRuns.get(tabId) ?? 0) + 1;
    translateRuns.set(tabId, run);
    const stale = () => versions.get(tabId) !== version || translateRuns.get(tabId) !== run;
    const targets = current.flatMap((page, i) => (page.transcript.state === 'done' && texts[i] ? [i] : []));
    if (targets.length === 0) return;
    for (const i of targets) {
      const t = current[i]!.transcript;
      if (t.state === 'done') current[i] = { ...current[i]!, transcript: { ...t, translating: true } };
    }
    deps.publish(tabId, [...current]);
    const seriesId = await deps.getSeriesId(tabId);
    for (const i of targets) {
      const transcript = await translateText(texts[i]!, translator, deps.cache, { seriesId, pageHash: current[i]!.pageHash });
      if (stale()) return;
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
    analyzed.delete(tabId);
    deps.publish(tabId, []);
  }

  return { update, translate, get, clear };
}
