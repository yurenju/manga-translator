import { describe, expect, it, vi } from 'vitest';
import type { TranslateInput } from '../shared/translator.ts';
import { CLAUDE_MODEL, costUsd, createClaudeTranslator, type ClaudeDeps } from './claude-translator.ts';

const input: TranslateInput = {
  seriesNotes: [
    { seriesId: 's1', 原文: '霧島湊', 讀音: 'きりしまみなと', 譯文: '霧島湊', 類別: '人名', locked: false },
  ],
  items: [
    { id: 'b1', kind: 'balloon', 原文: 'おはよう！今日は早いね', orientation: 'vertical' },
    { id: 'l1', kind: 'loose', 原文: 'ドドドド', orientation: 'vertical' },
  ],
};

/** structured outputs 回來的 JSON（text 區塊裡的字串）。 */
const answer = {
  items: [
    { id: 'b1', reading: 'おはよう！きょうははやいね', zh: '早安！今天好早喔', unreadable: false },
    { id: 'l1', reading: 'どどどど', zh: '', unreadable: true },
  ],
  notes_changes: {
    added: [{ ja: 'パン屋', reading: 'ぱんや', zh: '麵包店', category: '地名', note: '', selfRef: '', tone: '', address: '' }],
    filled: [{ ja: '霧島湊', reading: '', zh: '', category: '', note: '', selfRef: '僕', tone: '', address: '' }],
    suggestions: [{ ja: '霧島湊', zh: '霧島港', reason: '' }],
  },
};

const usage = { input_tokens: 300, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 700 };

function response(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}

const ok = () =>
  response({
    model: CLAUDE_MODEL,
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }],
    usage,
  });

function setup(responses: (() => Response)[], overrides: Partial<ClaudeDeps> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let clock = 1000;
  const deps: ClaudeDeps = {
    apiKey: 'sk-ant-test-1234',
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      clock += 2300;
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      return next();
    }),
    sleep: vi.fn(async () => {}),
    now: () => clock,
    ...overrides,
  };
  return { translator: createClaudeTranslator(deps), calls, deps };
}

describe('Claude 翻譯：request', () => {
  it('從瀏覽器直接呼叫 Messages API：Haiku 5.5、effort low、structured outputs、不關 thinking、不送 sampling 參數', async () => {
    const { translator, calls } = setup([ok]);

    await translator.translatePage(input);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test-1234',
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('stream');
  });

  it('Series Notes 放在標了 cache_control 的 system，這頁的原文（依閱讀順序、只帶 id）放在 user message', async () => {
    const { translator, calls } = setup([ok]);

    await translator.translatePage(input);

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.system).toHaveLength(1);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toContain('霧島湊');
    expect(body.system[0].text).not.toContain('s1'); // seriesId 不必送
    expect(body.messages).toHaveLength(1); // 不帶前一頁的對話
    expect(body.messages[0].role).toBe('user');
    const sent = JSON.parse(body.messages[0].content[0].text);
    expect(sent).toEqual([
      { id: 'b1', kind: 'balloon', ja: 'おはよう！今日は早いね' },
      { id: 'l1', kind: 'loose', ja: 'ドドドド' },
    ]);
  });

  it('同樣的 Series Notes 每頁送出的 system 逐字相同（prompt cache 才會命中）', async () => {
    const { translator, calls } = setup([ok, ok]);

    await translator.translatePage(input);
    await translator.translatePage({ ...input, items: [{ id: 'x', kind: 'balloon', 原文: '別のページ', orientation: 'vertical' }] });

    const [a, b] = calls.map((c) => JSON.parse(c.init.body as string));
    expect(a.system).toEqual(b.system);
    expect(a.output_config).toEqual(b.output_config);
  });
});

describe('Claude 翻譯：structured output 回應解析', () => {
  it('把讀音、譯文、unreadable 依 id 對回來', async () => {
    const { translator } = setup([ok]);

    const output = await translator.translatePage(input);

    expect(output.items).toEqual([
      { id: 'b1', 讀音: 'おはよう！きょうははやいね', 譯文: '早安！今天好早喔', unreadable: false },
      { id: 'l1', 讀音: 'どどどど', 譯文: '', unreadable: true },
    ]);
    expect(output.model).toBe('claude-haiku-5-5');
  });

  it('notes_changes 轉成新增／補空欄位／建議修改三種；空字串代表沒有這個欄位', async () => {
    const { translator } = setup([ok]);

    const output = await translator.translatePage(input);

    expect(output.notes_changes).toEqual({
      added: [{ 原文: 'パン屋', 讀音: 'ぱんや', 譯文: '麵包店', 類別: '地名' }],
      filled: [{ 原文: '霧島湊', fields: { 自稱: '僕' } }],
      suggestions: [{ 原文: '霧島湊', 建議譯文: '霧島港' }],
    });
  });

  it('記錄延遲、token 用量（input 含快取的部分）與費用', async () => {
    const { translator } = setup([ok]);

    const output = await translator.translatePage(input);

    expect(output.latencyMs).toBe(2300);
    expect(output.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 700,
      // 300 × 0.10 + 700 × 0.01 + 200 × 0.50（$/MTok）
      costUsd: 0.000137,
    });
  });

  it('回應被截斷（max_tokens）時視為失敗', async () => {
    const { translator } = setup([
      () => response({ model: CLAUDE_MODEL, stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"items":[' }], usage }),
    ]);

    await expect(translator.translatePage(input)).rejects.toThrow(/max_tokens/);
  });

  it('拒絕回答（refusal）時視為失敗', async () => {
    const { translator } = setup([() => response({ model: CLAUDE_MODEL, stop_reason: 'refusal', content: [], usage })]);

    await expect(translator.translatePage(input)).rejects.toThrow(/refusal/);
  });

  it('回應不符合 schema 時視為失敗', async () => {
    const { translator } = setup([
      () => response({ model: CLAUDE_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"items":[{"id":1}]}' }], usage }),
    ]);

    await expect(translator.translatePage(input)).rejects.toThrow(/格式/);
  });
});

describe('Claude 翻譯：錯誤與重試', () => {
  it('429 依 retry-after 等待後重試', async () => {
    const { translator, deps } = setup([
      () => response({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '7' } }),
      ok,
    ]);

    const output = await translator.translatePage(input);

    expect(output.items).toHaveLength(2);
    expect(deps.sleep).toHaveBeenCalledWith(7000, undefined);
  });

  it('429 最多重試 3 次，之後失敗並帶上 API 的錯誤訊息', async () => {
    const limited = () => response({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429 });
    const { translator, deps } = setup([limited, limited, limited, limited, ok]);

    await expect(translator.translatePage(input)).rejects.toThrow('Claude API 429：slow down');
    expect(deps.fetch).toHaveBeenCalledTimes(4);
  });

  it('沒有 retry-after 時用指數退避', async () => {
    const overloaded = () => response({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
    const { translator, deps } = setup([overloaded, overloaded, ok]);

    await translator.translatePage(input);

    expect(vi.mocked(deps.sleep).mock.calls.map(([ms]) => ms)).toEqual([2000, 4000]);
  });

  it('401 等用戶端錯誤不重試；錯誤訊息不含 API key', async () => {
    const { translator, deps } = setup([
      () => response({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
    ]);

    const error = await translator.translatePage(input).then(
      () => new Error('should have failed'),
      (e: unknown) => e as Error,
    );

    expect(error.message).toBe('Claude API 401：invalid x-api-key');
    expect(error.message).not.toContain('sk-ant-test-1234');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('把 AbortSignal 交給 fetch', async () => {
    const { translator, calls } = setup([ok]);
    const controller = new AbortController();

    await translator.translatePage(input, controller.signal);

    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});

describe('Claude 翻譯：測試連線', () => {
  it('用同一個 endpoint 與 header 送一個很小的 request，成功就回傳模型', async () => {
    const { translator, calls } = setup([() => response({ model: CLAUDE_MODEL, stop_reason: 'max_tokens', content: [], usage })]);

    await expect(translator.testConnection()).resolves.toEqual({ model: 'claude-haiku-5-5' });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(calls[0]!.init.body as string).max_tokens).toBeLessThanOrEqual(16);
  });

  it('key 錯誤時失敗並帶上 API 的錯誤訊息', async () => {
    const { translator } = setup([
      () => response({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
    ]);

    await expect(translator.testConnection()).rejects.toThrow('Claude API 401：invalid x-api-key');
  });
});

describe('費用', () => {
  it('Haiku 5.5：input $0.10、output $0.50、cache read $0.01、cache write $0.125（每百萬 token）', () => {
    expect(
      costUsd('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }),
    ).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125, 10);
  });

  it('不認得的模型不猜價格（回傳 NaN，由呼叫端顯示「未知」）', () => {
    expect(costUsd('claude-unknown', { input_tokens: 1, output_tokens: 1 })).toBeNaN();
  });
});
