import { describe, expect, it } from 'vitest';
import type { PageView } from '../shared/messages.ts';
import type { RatioRect } from '../shared/page-text.ts';
import { setupNotices, sidePanelView } from './view.ts';

type Transcript = PageView['transcript'];
type Done = Extract<Transcript, { state: 'done' }>;

const TEXT = { balloons: [], looseText: [] };

/** 翻譯好的一頁；info 是狀態列要顯示的模型・毫秒・費用。 */
function translated(info: { model?: string; latencyMs?: number; costUsd?: number; source?: 'translated' | 'cache' } = {}): Done {
  const { model = 'claude-x', latencyMs = 1000, costUsd = 0.001, source = 'translated' } = info;
  return {
    state: 'done',
    text: TEXT,
    translated: true,
    translation: { model, latencyMs, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd }, source },
  };
}

function page(pageHash: string, anchorId: string, extra: { subRect?: RatioRect; transcript?: Transcript } = {}): PageView {
  return {
    anchorId,
    rect: { x: 0, y: 0, width: 800, height: 600 },
    thumbnail: '',
    pageHash,
    transcript: { state: 'analyzing' },
    ...extra,
  };
}

/** Spread 切開的左半與右半（anchor 寬度的比例）。 */
const LEFT_HALF: RatioRect = { x: 0, y: 0, w: 0.5, h: 1 };
const RIGHT_HALF: RatioRect = { x: 0.5, y: 0, w: 0.5, h: 1 };

const listed = (pages: PageView[]) => sidePanelView(pages).pages.map((p) => [p.page.pageHash, p.side, p.heading]);

describe('side panel 的 Page 清單', () => {
  it('單頁照 SW 的順序，頁首是「第 N 頁」、不標左右', () => {
    expect(listed([page('p1', 'a1'), page('p2', 'a2')])).toEqual([
      ['p1', undefined, { title: '第 1 頁' }],
      ['p2', undefined, { title: '第 2 頁' }],
    ]);
  });

  const RIGHT_FIRST = [
    ['right', 'right', { title: '右頁', order: '先讀' }],
    ['left', 'left', { title: '左頁', order: '後讀' }],
  ];

  it('同一個 anchor 切出兩個 Page 是 Spread：右頁在前，頁首「右頁 · 先讀」「左頁 · 後讀」', () => {
    expect(listed([page('right', 'a1', { subRect: RIGHT_HALF }), page('left', 'a1', { subRect: LEFT_HALF })])).toEqual(RIGHT_FIRST);
  });

  it('SW 給的 Spread 順序是左頁在前，仍排成右頁在前', () => {
    expect(listed([page('left', 'a1', { subRect: LEFT_HALF }), page('right', 'a1', { subRect: RIGHT_HALF })])).toEqual(RIGHT_FIRST);
  });

  it('去黑邊的單頁（有 subRect、中心偏右）仍是「第 N 頁」，不是右頁', () => {
    const trimmed: RatioRect = { x: 0.3, y: 0, w: 0.5, h: 1 };
    expect(listed([page('p1', 'a1', { subRect: trimmed })])).toEqual([['p1', undefined, { title: '第 1 頁' }]]);
  });

  it('同一個 anchor 的兩個 Page 沒有 subRect：分不出左右，照 SW 的順序、頁首「第 N 頁」', () => {
    expect(listed([page('p1', 'a1'), page('p2', 'a1')])).toEqual([
      ['p1', undefined, { title: '第 1 頁' }],
      ['p2', undefined, { title: '第 2 頁' }],
    ]);
  });
});

const pageStatus = (transcript: Transcript) => sidePanelView([page('p1', 'a1', { transcript })]).pages[0]!.translationStatus;

describe('單頁的翻譯狀態列', () => {
  it('新翻譯：「已翻譯」・模型・秒數・費用', () => {
    expect(pageStatus(translated({ model: 'claude-x', latencyMs: 2345, costUsd: 0.01234 }))).toBe('已翻譯・claude-x・2.3 秒・$0.0123');
  });

  it('快取：「快取」・當初翻譯的模型與數字', () => {
    expect(pageStatus(translated({ model: 'claude-y', latencyMs: 800, costUsd: 0.002, source: 'cache' }))).toBe('快取・claude-y・0.8 秒・$0.0020');
  });

  it('還在辨識、正在翻譯、翻譯失敗時不顯示', () => {
    expect(pageStatus({ state: 'analyzing' })).toBeUndefined();
    expect(pageStatus({ ...translated(), translating: true })).toBeUndefined();
    expect(pageStatus({ ...translated(), translateError: 'boom' })).toBeUndefined();
  });
});

const overall = (transcripts: Transcript[]) => sidePanelView(transcripts.map((transcript, i) => page(`p${i}`, `a${i}`, { transcript }))).status;

describe('底部的整體狀態列', () => {
  it('多個 Page 時加總頁數、秒數、費用', () => {
    expect(
      overall([translated({ latencyMs: 1200, costUsd: 0.00123 }), translated({ latencyMs: 2300, costUsd: 0.00456 })]),
    ).toEqual({ kind: 'summary', text: '已翻譯 2 頁 · claude-x · 3.5 秒 · $0.00579' });
  });

  it('多個模型用「、」列出，同一個模型只列一次', () => {
    expect(overall([translated({ model: 'm1' }), translated({ model: 'm2' }), translated({ model: 'm1' })])).toMatchObject({
      text: expect.stringContaining('已翻譯 3 頁 · m1、m2 · '),
    });
  });

  it('有一頁的 Series Notes 過時：開頭加「Series Notes 已更新」', () => {
    expect(overall([{ ...translated({ latencyMs: 1000, costUsd: 0.001 }), stale: 'notes' }])).toEqual({
      kind: 'summary',
      text: 'Series Notes 已更新 · 已翻譯 1 頁 · claude-x · 1.0 秒 · $0.00100',
    });
  });

  it('只算有譯文的頁；快取的頁也算進去', () => {
    const kuromojiOnly: Transcript = { state: 'done', text: TEXT, translated: false };
    expect(overall([translated({ source: 'cache' }), kuromojiOnly, { state: 'analyzing' }])).toMatchObject({
      text: expect.stringMatching(/^已翻譯 1 頁 · /),
    });
  });

  it('有一頁正在翻譯：顯示「翻譯中」', () => {
    expect(overall([translated(), { ...translated(), translating: true }])).toEqual({ kind: 'translating' });
  });

  it('沒有任何譯文時不顯示', () => {
    expect(overall([])).toBeUndefined();
    expect(overall([{ state: 'analyzing' }, { state: 'pending' }, { state: 'done', text: TEXT, translated: false }])).toBeUndefined();
  });

  it('費用算不出來時顯示「費用未知」', () => {
    expect(overall([translated({ costUsd: Number.NaN })])).toMatchObject({ text: expect.stringMatching(/ · 費用未知$/) });
  });
});

describe('翻譯前的設定提示', () => {
  it('內建翻譯、沒登入：顯示「尚未登入」，即使還沒有頁；不顯示資料使用說明卡（同意在登入時取得）', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: false }, consented: false, untranslated: false })).toEqual({
      consentCard: false,
      notice: 'signedOut',
    });
  });

  it('內建翻譯、已登入而且同意了：什麼都不顯示', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: true }, consented: true, untranslated: true })).toEqual({
      consentCard: false,
      notice: undefined,
    });
  });

  it('內建翻譯、有 token 但同意被撤回：也是「尚未登入」，重新登入就會再同意', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: true }, consented: false, untranslated: false }).notice).toBe('signedOut');
  });

  it('自備金鑰：沒同意顯示資料使用說明卡；沒有 key 而且有未翻譯的頁才提示設定 key', () => {
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: false }, consented: false, untranslated: false })).toEqual({
      consentCard: true,
      notice: undefined,
    });
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: false }, consented: true, untranslated: true })).toEqual({
      consentCard: false,
      notice: 'noKey',
    });
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: true }, consented: true, untranslated: true }).notice).toBeUndefined();
  });

  it('同意狀態還在讀：什麼都不顯示，不會閃一下', () => {
    expect(setupNotices({ access: { mode: 'hosted', signedIn: false }, consented: undefined, untranslated: true })).toEqual({
      consentCard: false,
      notice: undefined,
    });
    expect(setupNotices({ access: { mode: 'ownKey', hasKey: false }, consented: undefined, untranslated: false }).consentCard).toBe(false);
  });
});
