import { describe, expect, it } from 'vitest';
import { extractImages, sessionName, sessionsToPrune } from './debug-session.ts';

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
