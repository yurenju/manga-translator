import { describe, expect, it, vi } from 'vitest';
import type { CropRequest, PageThumb, PageView } from '../shared/messages.ts';
import type { PageText } from '../shared/page-text.ts';
import type { TranslateInput, Translator } from '../shared/translator.ts';
import { createTranscriber, type TranscriberDeps } from './transcribe.ts';

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

const thumb = (anchorId: string): PageThumb => ({ anchorId, rect: { x: 0, y: 0, width: 10, height: 10 }, thumbnail: `data:${anchorId}` });
const capture: CropRequest = { screenshot: 'data:shot', viewport: { width: 100, height: 100 }, candidates: [] };

function setup(overrides: Partial<TranscriberDeps> = {}) {
  const published: PageView[][] = [];
  const deps: TranscriberDeps = {
    analyze: vi.fn(async () => structuredClone(pageText)),
    getTranslator: () => undefined,
    publish: (_tabId, pages) => published.push(structuredClone(pages)),
    ...overrides,
  };
  return { transcriber: createTranscriber(deps), published, deps };
}

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

  it('Translator 失敗時保留 kuromoji 讀音、標示未翻譯', async () => {
    const translator: Translator = { translatePage: async () => Promise.reject(new Error('429')) };
    const { transcriber, published } = setup({ getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(published.at(-1)![0]!.transcript).toEqual({ state: 'done', text: pageText, translated: false });
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
