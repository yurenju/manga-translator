import { describe, expect, it } from 'vitest';
import { extractImages, latestSession, sessionName, sessionsToPrune, summarize } from './debug-session.ts';

describe('sessionName', () => {
  it('用本地時間命名，字典序就是時間順序', () => {
    expect(sessionName(new Date(2026, 9, 26, 9, 5, 7))).toBe('20261026-090507');
  });
});

describe('sessionsToPrune', () => {
  it('只留最新的幾個，其他（不管順序）都刪', () => {
    const names = ['20261026-090000', '20261024-120000', '20261026-100000', '20261025-080000'];

    expect(sessionsToPrune(names, 2).sort()).toEqual(['20261024-120000', '20261025-080000']);
    expect(sessionsToPrune(names, 10)).toEqual([]);
  });

  it('不是 session 名稱的資料夾不動', () => {
    expect(sessionsToPrune(['notes', '20261024-120000', '20261026-100000'], 1)).toEqual(['20261024-120000']);
  });
});

describe('extractImages', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  it('把任何深度的 data:image/ 字串換成圖片路徑，並回傳要寫的檔案', () => {
    let n = 0;
    const { data, images } = extractImages({ screenshot: png, pages: [{ thumbnail: png, pageHash: 'ab' }] }, (ext) => `images/${++n}.${ext}`);

    expect(data).toEqual({ screenshot: 'images/1.png', pages: [{ thumbnail: 'images/2.png', pageHash: 'ab' }] });
    expect(images).toEqual([
      { path: 'images/1.png', bytes: Buffer.from('iVBORw0KGgo=', 'base64') },
      { path: 'images/2.png', bytes: Buffer.from('iVBORw0KGgo=', 'base64') },
    ]);
  });

  it('其他值原樣保留', () => {
    const { data, images } = extractImages({ text: 'data:text/plain,hi', n: 1, nil: null }, () => 'x');

    expect(data).toEqual({ text: 'data:text/plain,hi', n: 1, nil: null });
    expect(images).toEqual([]);
  });
});

describe('latestSession', () => {
  it('最新的 session；沒有就是 undefined', () => {
    expect(latestSession(['notes', '20261024-120000', '20261026-100000'])).toBe('20261026-100000');
    expect(latestSession(['notes'])).toBeUndefined();
  });
});

describe('summarize', () => {
  const hash = '7051856d4facd4d8a04369ef7c9416da1a97d82d25686b27c61c3edcca3c49a7';
  const rect = { x: 519.4, y: 0, width: 548, height: 800 };
  const candidates = (at: number, x: number) => ({
    ctx: 'content',
    event: 'candidates',
    at,
    data: {
      candidates: [{ anchorId: 'a1', rect: { ...rect, x } }],
      rejected: [
        { tag: 'canvas', rect, reason: 'outsideViewport', clips: [] },
        { tag: 'canvas', rect, reason: 'outsideViewport', clips: [] },
        { tag: 'canvas', rect, reason: 'clipped', clips: [rect] },
      ],
    },
  });

  it('每筆一行：行號（對應 trace.jsonl）、相對秒數、context、事件；hash 縮短、rect 精簡', () => {
    const lines = summarize([
      { ctx: 'sw', event: 'cache:hit', at: 1000, data: { pageHash: hash, rect } },
      { ctx: 'console', event: 'warning', at: 3500, text: 'translate failed' },
    ]);

    expect(lines).toEqual(['    1     0.0 sw cache:hit {"pageHash":"7051856d","rect":"519,0 548x800"}', '    2     2.5 console warning translate failed']);
  });

  it('被排除的候選只列各原因的數量', () => {
    const [line] = summarize([candidates(0, 519)]);

    expect(line).toContain('"rejected":{"outsideViewport":2,"clipped":1}');
    expect(line).toContain('"candidates":[{"anchorId":"a1","rect":"519,0 548x800"}]');
  });

  it('跟上一筆 candidates 內容相同的（截圖前後各量一次）不列', () => {
    const lines = summarize([
      candidates(0, 519),
      { ctx: 'sw', event: 'capture', at: 200, data: {} },
      candidates(300, 519),
      candidates(400, 326),
    ]);

    expect(lines.map((l) => l.slice(0, 5).trim())).toEqual(['1', '2', '4']);
  });
});
