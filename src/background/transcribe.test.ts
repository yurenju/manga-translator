import { describe, expect, it, vi } from 'vitest';
import type { AnalyzeRequest, CropRequest, PageThumb, PageView } from '../shared/messages.ts';
import type { PageText, PageTranslation } from '../shared/page-text.ts';
import type { TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';
import { createTranscriber, type PageCache, type TranscriberDeps } from './transcribe.ts';

const rect = { x: 0, y: 0, w: 1, h: 1 };

const pageText: PageText = {
  balloons: [
    {
      id: 'b1',
      order: 1,
      balloonBbox: rect,
      textBbox: rect,
      orientation: 'vertical',
      原文: '今日は',
      讀音: 'こんにちは',
      讀音來源: 'kuromoji',
      譯文: '',
      unreadable: false,
    },
  ],
  looseText: [
    { id: 'l1', order: 2, bbox: rect, orientation: 'horizontal', 原文: 'ドン', 讀音: 'どん', 讀音來源: 'kuromoji', 譯文: '', unreadable: false },
  ],
};

/** 每個 anchor 預設一個互相距離 ≥ 128 bits 的 hash（同 hash＝同一個 Page，會去重）。 */
const HASHES: Record<string, string> = {
  a1: '0'.repeat(64),
  a2: 'f'.repeat(64),
  a3: '0f'.repeat(32),
  a4: 'f0'.repeat(32),
  a5: '00ff'.repeat(16),
};

const thumb = (anchorId: string, pageHash = HASHES[anchorId] ?? '0'.repeat(64)): PageThumb => ({
  anchorId,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  thumbnail: `data:${anchorId}`,
  pageHash,
});
const capture: CropRequest = { screenshot: 'data:shot', viewport: { width: 100, height: 100 }, candidates: [] };

/** 記憶體裡的快取；查詢只比對完全相同的 hash（門檻比對由 page-hash.test.ts 負責）。 */
function memoryCache(): PageCache & { saved: PageTranslation[] } {
  const saved: PageTranslation[] = [];
  return {
    saved,
    find: async (seriesId, pageHash) => saved.find((t) => t.seriesId === seriesId && t.pageHash === pageHash),
    save: async (translation) => void saved.push(structuredClone(translation)),
  };
}

function setup(overrides: Partial<TranscriberDeps> = {}) {
  const published: PageView[][] = [];
  const deps: TranscriberDeps = {
    analyze: vi.fn(async () => structuredClone(pageText)),
    getTranslator: () => undefined,
    getSeriesId: async () => 'series-1',
    cache: memoryCache(),
    publish: (_tabId, pages) => published.push(structuredClone(pages)),
    ...overrides,
  };
  return { transcriber: createTranscriber(deps), published, deps };
}

function translatorReturning(zh: string, calls: TranslateInput[] = []): Translator {
  return {
    async translatePage(input) {
      calls.push(input);
      return {
        items: input.items.map((i) => ({ id: i.id, 讀音: `${i.id}-讀音`, 譯文: `${zh}-${i.id}`, unreadable: false })),
        notes_changes: { added: [], filled: [], suggestions: [] },
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, costUsd: 0.000137 },
        model: 'claude-haiku-5-5',
        latencyMs: 2300,
      };
    },
  };
}

const translatedOutput = (): TranslateOutput => ({
  items: [
    { id: 'b1', 讀音: 'きょうは', 譯文: '今天', unreadable: false },
    { id: 'l1', 讀音: 'どん', 譯文: '咚', unreadable: false },
  ],
  notes_changes: { added: [], filled: [], suggestions: [] },
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.0003 },
  model: 'claude-haiku-5-5',
  latencyMs: 2300,
});

describe('逐字稿：本機流水線＋Translator', () => {
  it('先列出縮圖（分析中），分析完顯示原文＋kuromoji 讀音，沒有 Translator 時標示未翻譯', async () => {
    const { transcriber, published } = setup();

    await transcriber.update(1, [thumb('a1')], capture);

    expect(published[0]!.map((p) => p.transcript)).toEqual([{ state: 'analyzing' }]);
    expect(published.at(-1)!.map((p) => p.transcript)).toEqual([{ state: 'done', text: pageText, translated: false }]);
    expect(transcriber.get(1)).toEqual(published.at(-1));
  });

  it('有 Translator 時依閱讀順序送出原文，讀音與譯文換成它的結果', async () => {
    let input: TranslateInput | undefined;
    const translator: Translator = {
      async translatePage(i) {
        input = i;
        return {
          items: [
            { id: 'b1', 讀音: 'きょうは', 譯文: '今天', unreadable: false },
            { id: 'l1', 讀音: 'どん', 譯文: '咚', unreadable: true },
          ],
          notes_changes: { added: [], filled: [], suggestions: [] },
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
          model: 'fake',
          latencyMs: 0,
        };
      },
    };
    const { transcriber, published } = setup({ getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(input).toEqual({
      seriesNotes: [],
      items: [
        { id: 'b1', kind: 'balloon', 原文: '今日は', orientation: 'vertical' },
        { id: 'l1', kind: 'loose', 原文: 'ドン', orientation: 'horizontal' },
      ],
    });
    const last = published.at(-1)![0]!.transcript;
    expect(last.state === 'done' && last.translated).toBe(true);
    if (last.state !== 'done') return;
    expect(last.text.balloons[0]).toMatchObject({ 讀音: 'きょうは', 讀音來源: 'llm', 譯文: '今天', unreadable: false });
    expect(last.text.looseText[0]).toMatchObject({ 讀音: 'どん', 讀音來源: 'llm', 譯文: '咚', unreadable: true });
  });

  it('Translator 失敗時保留 kuromoji 讀音、標示未翻譯，並帶上錯誤訊息', async () => {
    const translator: Translator = { translatePage: async () => Promise.reject(new Error('Claude API 429：slow down')) };
    const { transcriber, published } = setup({ getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(published.at(-1)![0]!.transcript).toEqual({
      state: 'done',
      text: pageText,
      translated: false,
      translateError: 'Claude API 429：slow down',
    });
  });

  it('翻譯成功時帶上模型、秒數與費用（狀態列用）', async () => {
    const { transcriber } = setup({ getTranslator: async () => translatorReturning('今天') });

    await transcriber.update(1, [thumb('a1')], capture);

    const transcript = transcriber.get(1)[0]!.transcript;
    expect(transcript.state === 'done' && transcript.translation).toEqual({
      source: 'translated',
      model: 'claude-haiku-5-5',
      latencyMs: 2300,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, costUsd: 0.000137 },
    });
  });

  it('本機流水線失敗（例如模型 SHA-256 不符）時這頁顯示錯誤', async () => {
    const { transcriber, published } = setup({ analyze: async () => Promise.reject(new Error('模型檔 SHA-256 不符')) });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(published.at(-1)![0]!.transcript).toEqual({ state: 'error', message: '模型檔 SHA-256 不符' });
  });

  it('每個 Page 依序分析，各自帶上自己的候選', async () => {
    const { transcriber, deps } = setup();

    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);

    expect(vi.mocked(deps.analyze).mock.calls.map(([request]) => request.candidate.anchorId)).toEqual(['a1', 'a2']);
  });

  it('停止（clear）之後才完成的分析結果丟掉', async () => {
    let finish!: (text: PageText) => void;
    const { transcriber, published } = setup({ analyze: () => new Promise((resolve) => (finish = resolve)) });

    const running = transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(finish).toBeDefined());
    transcriber.clear(1);
    finish(pageText);
    await running;

    expect(transcriber.get(1)).toEqual([]);
    expect(published.at(-1)).toEqual([]);
  });

  it('新的擷取取代舊的：舊的分析結果不會蓋掉新的', async () => {
    const finishers: ((text: PageText) => void)[] = [];
    const { transcriber } = setup({ analyze: () => new Promise((resolve) => finishers.push(resolve)) });

    const first = transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(finishers.length).toBeGreaterThan(0));
    const second = transcriber.update(1, [thumb('a2')], capture);
    finishers[0]!(pageText);
    await first;

    expect(transcriber.get(1).map((p) => [p.anchorId, p.transcript.state])).toEqual([['a2', 'analyzing']]);
    await vi.waitFor(() => expect(finishers).toHaveLength(2));
    finishers[1]!(pageText);
    await second;
    expect(transcriber.get(1).map((p) => [p.anchorId, p.transcript.state])).toEqual([['a2', 'done']]);
  });
});

describe('翻譯此頁', () => {
  it('沒有 key 時擷取的 Page 設定 key 後按「翻譯此頁」：不重跑本機流水線，用同一份 OCR 結果翻譯', async () => {
    let translator: Translator | undefined;
    const calls: TranslateInput[] = [];
    const { transcriber, published, deps } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    expect(transcriber.get(1).every((p) => p.transcript.state === 'done' && !p.transcript.translated)).toBe(true);

    translator = translatorReturning('今天', calls);
    published.length = 0;
    await transcriber.translate(1);

    expect(deps.analyze).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    // 先標翻譯中，再一頁一頁換成譯文
    expect(published[0]!.map((p) => p.transcript.state === 'done' && p.transcript.translating)).toEqual([true, true]);
    const pages = transcriber.get(1);
    for (const page of pages) {
      expect(page.transcript.state === 'done' && page.transcript.translated).toBe(true);
      expect(page.transcript.state === 'done' && page.transcript.translating).toBeFalsy();
    }
    const first = pages[0]!.transcript;
    if (first.state !== 'done') throw new Error('not done');
    expect(first.text.balloons[0]).toMatchObject({ 讀音: 'b1-讀音', 讀音來源: 'llm', 譯文: '今天-b1' });
  });

  it('重新翻譯失敗時退回 kuromoji 讀音（不是上一次的譯文），並顯示錯誤', async () => {
    let translator: Translator = translatorReturning('今天');
    const { transcriber } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);

    translator = { translatePage: async () => Promise.reject(new Error('Claude API 500：boom')) };
    await transcriber.translate(1);

    expect(transcriber.get(1)[0]!.transcript).toEqual({ state: 'done', text: pageText, translated: false, translateError: 'Claude API 500：boom' });
  });

  it('還沒設定 key 時按「翻譯此頁」不改變逐字稿', async () => {
    const { transcriber, published } = setup();
    await transcriber.update(1, [thumb('a1')], capture);
    const before = published.length;

    await transcriber.translate(1);

    expect(published).toHaveLength(before);
    expect(transcriber.get(1)[0]!.transcript).toEqual({ state: 'done', text: pageText, translated: false });
  });

  it('分析失敗的 Page 不送翻譯', async () => {
    const calls: TranslateInput[] = [];
    const { transcriber } = setup({ analyze: async () => Promise.reject(new Error('壞掉')), getTranslator: () => translatorReturning('x', calls) });
    await transcriber.update(1, [thumb('a1')], capture);

    await transcriber.translate(1);

    expect(calls).toEqual([]);
    expect(transcriber.get(1)[0]!.transcript.state).toBe('error');
  });

  it('翻譯中又有新的擷取時，舊的翻譯結果丟掉', async () => {
    let finish: (() => void) | undefined;
    const slow: Translator = {
      translatePage: (input) =>
        new Promise((resolve) => {
          finish = () => void translatorReturning('舊').translatePage(input).then(resolve);
        }),
    };
    let translator: Translator | undefined;
    const { transcriber } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);

    translator = slow;
    const running = transcriber.translate(1);
    await vi.waitFor(() => expect(finish).toBeDefined());
    translator = undefined;
    await transcriber.update(1, [thumb('a2')], capture);
    finish!();
    await running;

    expect(transcriber.get(1).map((p) => [p.anchorId, p.transcript.state === 'done' && p.transcript.translated])).toEqual([['a2', false]]);
  });
});

describe('翻譯快取', () => {
  function countingTranslator() {
    const translator = { translatePage: vi.fn(async () => translatedOutput()) } satisfies Translator;
    return translator;
  }

  it('翻譯完寫進快取：key 是這個 tab 的 Series ID 與 Page hash，只存文字與座標', async () => {
    const cache = memoryCache();
    const translator = countingTranslator();
    const { transcriber } = setup({ cache, getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1', 'ab'.repeat(32))], capture);

    expect(cache.saved).toHaveLength(1);
    const saved = cache.saved[0]!;
    expect(saved).toMatchObject({
      seriesId: 'series-1',
      pageHash: 'ab'.repeat(32),
      model: 'claude-haiku-5-5',
      latencyMs: 2300,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.0003 },
    });
    expect(saved.balloons[0]).toMatchObject({ id: 'b1', 原文: '今日は', 譯文: '今天', 讀音來源: 'llm' });
    expect(saved.looseText[0]).toMatchObject({ id: 'l1', 原文: 'ドン', 譯文: '咚' });
    expect(JSON.stringify(saved)).not.toContain('data:');
  });

  it('翻譯完的狀態是「已翻譯」，帶模型、秒數、費用', async () => {
    const { transcriber, published } = setup({ getTranslator: () => countingTranslator() });

    await transcriber.update(1, [thumb('a1')], capture);

    const last = published.at(-1)![0]!.transcript;
    expect(last.state === 'done' && last.translation).toEqual({
      source: 'translated',
      model: 'claude-haiku-5-5',
      latencyMs: 2300,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.0003 },
    });
  });

  it('同一個 Series 已有這個 Page：直接用快取，不跑本機流水線也不呼叫 Translator，狀態是「快取」', async () => {
    const cache = memoryCache();
    const translator = countingTranslator();
    const first = setup({ cache, getTranslator: () => translator });
    await first.transcriber.update(1, [thumb('a1')], capture);

    // 重新整理後 anchor 換了，但 Page 一樣
    const second = setup({ cache, getTranslator: () => translator });
    await second.transcriber.update(1, [thumb('a7')], capture);

    expect(translator.translatePage).toHaveBeenCalledTimes(1);
    expect(second.deps.analyze).not.toHaveBeenCalled();
    const last = second.published.at(-1)![0]!;
    expect(last.anchorId).toBe('a7');
    expect(last.transcript.state === 'done' && last.transcript.translation?.source).toBe('cache');
    if (last.transcript.state !== 'done') return;
    expect(last.transcript.translated).toBe(true);
    expect(last.transcript.text.balloons[0]).toMatchObject({ 原文: '今日は', 譯文: '今天' });
    expect(last.transcript.translation).toMatchObject({ model: 'claude-haiku-5-5', latencyMs: 2300, usage: { costUsd: 0.0003 } });
  });

  it('別的 Series 的快取不算數', async () => {
    const cache = memoryCache();
    const translator = countingTranslator();
    await setup({ cache, getTranslator: () => translator, getSeriesId: async () => 'series-1' }).transcriber.update(1, [thumb('a1')], capture);

    await setup({ cache, getTranslator: () => translator, getSeriesId: async () => 'series-2' }).transcriber.update(1, [thumb('a1')], capture);

    expect(translator.translatePage).toHaveBeenCalledTimes(2);
  });

  it('擷取後才設定 key、按「翻譯此頁」成功時也寫進快取', async () => {
    const cache = memoryCache();
    let translator: Translator | undefined;
    const { transcriber } = setup({ cache, getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1', 'cd'.repeat(32))], capture);
    expect(cache.saved).toEqual([]);

    translator = countingTranslator();
    await transcriber.translate(1);

    expect(cache.saved).toHaveLength(1);
    expect(cache.saved[0]).toMatchObject({ seriesId: 'series-1', pageHash: 'cd'.repeat(32) });
  });

  it('沒有 Translator（未翻譯）或翻譯失敗時不寫快取', async () => {
    const cache = memoryCache();
    await setup({ cache }).transcriber.update(1, [thumb('a1')], capture);
    const failing: Translator = { translatePage: async () => Promise.reject(new Error('429')) };
    await setup({ cache, getTranslator: () => failing }).transcriber.update(1, [thumb('a2')], capture);

    expect(cache.saved).toEqual([]);
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 本機流水線由測試一個一個放行；calls 依開始順序記 anchorId。 */
function gatedAnalyze() {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const analyze = vi.fn(
    (request: AnalyzeRequest) =>
      new Promise<PageText>((resolve) => {
        calls.push(request.candidate.anchorId);
        pending.push(() => resolve(structuredClone(pageText)));
      }),
  );
  /** 放行最早開始、還沒放行的那一個，並等佇列往下走。 */
  async function finishNext() {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending.shift()!();
    await flush();
  }
  return { analyze, calls, finishNext };
}

describe('翻譯佇列（#34）', () => {
  it('後進先出：本機段一次一個，新出現的可見 Page 先做', async () => {
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze });

    void transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    void transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    void transcriber.update(1, [thumb('a1'), thumb('a2'), thumb('a3')], capture);
    await flush();
    expect(gate.calls).toEqual(['a1']);

    await gate.finishNext();
    expect(gate.calls).toEqual(['a1', 'a3']);
    await gate.finishNext();
    expect(gate.calls).toEqual(['a1', 'a3', 'a2']);
  });

  it('翻太快：已不在畫面上、還沒開始的工作丟掉；之後再出現時重新排', async () => {
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze });

    void transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    void transcriber.update(1, [thumb('a2')], capture);
    void transcriber.update(1, [thumb('a3')], capture);
    await flush();
    await gate.finishNext();
    await gate.finishNext();
    expect(gate.calls).toEqual(['a1', 'a3']);

    void transcriber.update(1, [thumb('a2')], capture);
    await gate.finishNext();
    expect(gate.calls).toEqual(['a1', 'a3', 'a2']);
  });

  it('已開始的工作翻走後照樣做完、寫進快取，但不顯示也不覆蓋', async () => {
    const gate = gatedAnalyze();
    const cache = memoryCache();
    const { transcriber, published } = setup({ analyze: gate.analyze, cache, getTranslator: () => translatorReturning('今天') });

    void transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    void transcriber.update(1, [thumb('a2')], capture);
    await flush();
    published.length = 0;
    await gate.finishNext();
    await flush();

    expect(cache.saved.map((t) => t.pageHash)).toEqual([HASHES.a1]);
    expect(published.flat().some((p) => p.anchorId === 'a1')).toBe(false);
    expect(transcriber.get(1).map((p) => p.anchorId)).toEqual(['a2']);
  });

  it('同一個 Page（hash 在門檻內）已有工作在跑：不重複排，等那份結果', async () => {
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze });
    // 跟 a1 差 1 bit：同一頁重新截圖
    const nearlyA1 = '1' + '0'.repeat(63);

    const first = transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    const second = transcriber.update(1, [thumb('a9', nearlyA1)], capture);
    await gate.finishNext();
    await Promise.all([first, second]);

    expect(gate.analyze).toHaveBeenCalledTimes(1);
    expect(transcriber.get(1).map((p) => [p.anchorId, p.transcript.state])).toEqual([['a9', 'done']]);
  });

  it('翻走再翻回來：命中快取（狀態是「快取」），不再翻譯', async () => {
    const translator = { translatePage: vi.fn(async () => translatedOutput()) } satisfies Translator;
    const { transcriber } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.update(1, [thumb('a2')], capture);

    await transcriber.update(1, [thumb('a1')], capture);

    expect(translator.translatePage).toHaveBeenCalledTimes(2);
    const t = transcriber.get(1)[0]!.transcript;
    expect(t.state === 'done' && t.translation?.source).toBe('cache');
  });

  it('本機流水線失敗的 Page 下次擷取時重跑（例如修好模型後按重試）', async () => {
    let fail = true;
    const { transcriber } = setup({ analyze: async () => (fail ? Promise.reject(new Error('模型檔 SHA-256 不符')) : structuredClone(pageText)) });
    await transcriber.update(1, [thumb('a1')], capture);
    expect(transcriber.get(1)[0]!.transcript.state).toBe('error');

    fail = false;
    await transcriber.update(1, [thumb('a1')], capture);

    expect(transcriber.get(1)[0]!.transcript.state).toBe('done');
  });

  it('Series 換了 ID（reassignSeries，#36 合併）：之後重新翻譯寫進新的 ID', async () => {
    const translator = { translatePage: vi.fn(async () => translatedOutput()) } satisfies Translator;
    const cache = memoryCache();
    const { transcriber } = setup({ getTranslator: () => translator, cache });
    await transcriber.update(1, [thumb('a1')], capture);
    expect(cache.saved.map((t) => t.seriesId)).toEqual(['series-1']);

    transcriber.reassignSeries(1, 'series-2');
    await transcriber.translate(1);

    expect(cache.saved.map((t) => t.seriesId)).toEqual(['series-1', 'series-2']);
  });

  it('同 origin 重新整理（resetPages）：同一頁重新從快取拿，自動翻譯設定保留', async () => {
    const translator = { translatePage: vi.fn(async () => translatedOutput()) } satisfies Translator;
    const { transcriber, published } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.setAutoTranslate(1, false);

    transcriber.resetPages(1);
    expect(published.at(-1)).toEqual([]);
    await transcriber.update(1, [thumb('a5', HASHES.a1)], capture);

    const t = transcriber.get(1)[0]!.transcript;
    expect(t.state === 'done' && t.translation?.source).toBe('cache');
    expect(transcriber.isAutoTranslate(1)).toBe(false);
  });

  it('LLM 段併發 2；等 LLM 時本機段繼續做下一頁', async () => {
    const llmCalls: (() => void)[] = [];
    const translator: Translator = {
      translatePage: (input) =>
        new Promise((resolve) => llmCalls.push(() => void translatorReturning('x').translatePage(input).then(resolve))),
    };
    const { transcriber, deps } = setup({ getTranslator: () => translator });

    const running = transcriber.update(1, [thumb('a1'), thumb('a2'), thumb('a3')], capture);
    await vi.waitFor(() => expect(deps.analyze).toHaveBeenCalledTimes(3));
    await flush();
    expect(llmCalls).toHaveLength(2);

    llmCalls[0]!();
    await vi.waitFor(() => expect(llmCalls).toHaveLength(3));
    llmCalls[1]!();
    llmCalls[2]!();
    await running;
    expect(transcriber.get(1).every((p) => p.transcript.state === 'done' && p.transcript.translated)).toBe(true);
  });

  it('429 重試後仍失敗：顯示錯誤；按「重試」只重送 LLM、不重跑本機流水線', async () => {
    let translator: Translator = { translatePage: async () => Promise.reject(new Error('Claude API 429：rate limited')) };
    const { transcriber, deps } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);
    const failed = transcriber.get(1)[0]!.transcript;
    expect(failed.state === 'done' && failed.translateError).toBe('Claude API 429：rate limited');

    translator = translatorReturning('今天');
    await transcriber.translate(1);

    expect(deps.analyze).toHaveBeenCalledTimes(1);
    const retried = transcriber.get(1)[0]!.transcript;
    expect(retried.state === 'done' && retried.translated && !retried.translateError).toBe(true);
  });
});

describe('自動翻譯開關', () => {
  it('預設開；關掉後新 Page 停在「未翻譯」，不跑本機流水線；按「翻譯此頁」才翻', async () => {
    const calls: TranslateInput[] = [];
    const { transcriber, deps } = setup({ getTranslator: () => translatorReturning('今天', calls) });
    expect(transcriber.isAutoTranslate(1)).toBe(true);

    await transcriber.setAutoTranslate(1, false);
    await transcriber.update(1, [thumb('a1')], capture);

    expect(deps.analyze).not.toHaveBeenCalled();
    expect(transcriber.get(1)[0]!.transcript).toEqual({ state: 'pending' });

    await transcriber.translate(1);
    expect(deps.analyze).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const t = transcriber.get(1)[0]!.transcript;
    expect(t.state === 'done' && t.translated).toBe(true);
  });

  it('關著時快取命中照樣直接顯示', async () => {
    const cache = memoryCache();
    await setup({ cache, getTranslator: () => translatorReturning('今天') }).transcriber.update(1, [thumb('a1')], capture);
    const { transcriber } = setup({ cache, getTranslator: () => translatorReturning('今天') });

    await transcriber.setAutoTranslate(1, false);
    await transcriber.update(1, [thumb('a1')], capture);

    const t = transcriber.get(1)[0]!.transcript;
    expect(t.state === 'done' && t.translation?.source).toBe('cache');
  });

  it('停止後回到預設（開）', async () => {
    const { transcriber } = setup();
    await transcriber.setAutoTranslate(1, false);

    transcriber.clear(1);

    expect(transcriber.isAutoTranslate(1)).toBe(true);
  });
});
