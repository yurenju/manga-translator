import { describe, expect, it } from 'vitest';
import type { PageView } from '../shared/messages.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import { createOverlaySync } from './overlay-sync.ts';

const TEXT: PageText = { balloons: [], looseText: [] };
const page = (anchorId: string, transcript: PageView['transcript'], pageHash = '0'.repeat(64)): PageView => ({
  anchorId,
  rect: { x: 0, y: 0, width: 430, height: 625 },
  thumbnail: 'data:',
  pageHash,
  transcript,
});

function setup() {
  const shown: [number, string, PageText][] = [];
  const pageHashes: string[] = [];
  const subs: (RatioRect | undefined)[] = [];
  const sync = createOverlaySync({
    show: ({ tabId, anchorId, pageHash, sub, text }) => {
      shown.push([tabId, anchorId, text]);
      pageHashes.push(pageHash);
      subs.push(sub);
    },
  });
  return { sync, shown, pageHashes, subs };
}

describe('overlay sync', () => {
  it('Page 翻好時把譯文送給 content script 覆蓋，同一份結果只送一次', () => {
    const { sync, shown } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };

    sync.publish(1, [page('a1', done), page('a2', { state: 'analyzing' })]);
    sync.publish(1, [page('a1', done), page('a2', { state: 'analyzing' })]);

    expect(shown).toEqual([[1, 'a1', TEXT]]);
  });

  it('沒有譯文（沒有 API key）或辨識失敗的 Page 不覆蓋', () => {
    const { sync, shown } = setup();

    sync.publish(1, [page('a1', { state: 'done', text: TEXT, translated: false }), page('a2', { state: 'error', message: 'x' })]);

    expect(shown).toEqual([]);
  });

  it('同一個 anchor 有新的翻譯結果時再送一次', () => {
    const { sync, shown } = setup();
    const other: PageText = { balloons: [], looseText: [] };

    sync.publish(1, [page('a1', { state: 'done', text: TEXT, translated: true })]);
    sync.publish(1, [page('a1', { state: 'done', text: other, translated: true })]);

    expect(shown.map(([, , text]) => text)).toEqual([TEXT, other]);
  });

  it('同一個 anchor 上的兩個 Page（Spread）各自帶上 Page 身分，hover 同步才分得出是哪一頁', () => {
    const { sync, pageHashes } = setup();
    const left: PageText = { balloons: [], looseText: [] };
    const right: PageText = { balloons: [], looseText: [] };

    sync.publish(1, [page('a1', { state: 'done', text: left, translated: true }, 'aa'.repeat(32)), page('a1', { state: 'done', text: right, translated: true }, 'bb'.repeat(32))]);

    expect(pageHashes).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
  });

  it('Spread 的一頁帶上它在 anchor 裡的範圍（subRect）', () => {
    const { sync, subs } = setup();
    const sub = { x: 0.5, y: 0, w: 0.5, h: 1 };

    sync.publish(1, [{ ...page('a1', { state: 'done', text: TEXT, translated: true }), sub }]);

    expect(subs).toEqual([sub]);
  });

  it('重新擷取時 anchor 上已經沒有這頁的覆蓋（例如 img 換了 src 又換回來、視窗大小變了重畫）：再送一次', () => {
    const { sync, shown } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };

    sync.publish(1, [page('a1', done)]);
    sync.captured(1, [page('a1', done)]);
    sync.publish(1, [page('a1', done)]);

    expect(shown).toHaveLength(2);
  });

  it('重新擷取時 anchor 上還顯示著這頁：不重送', () => {
    const { sync, shown } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };
    const hash = '0'.repeat(64);

    sync.publish(1, [page('a1', done)]);
    sync.captured(1, [{ ...page('a1', done), overlaid: [hash] }]);
    sync.publish(1, [page('a1', done)]);

    expect(shown).toHaveLength(1);
  });

  it('這次擷取沒看到那個 anchor（捲走了）：覆蓋還掛在它上面，捲回來時不重送', () => {
    const { sync, shown } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };

    sync.publish(1, [page('a1', done)]);
    sync.captured(1, [page('a2', { state: 'analyzing' }, 'f'.repeat(64))]);
    sync.publish(1, [page('a1', done)]);

    expect(shown).toHaveLength(1);
  });
});
