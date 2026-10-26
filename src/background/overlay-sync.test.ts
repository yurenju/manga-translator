import { describe, expect, it } from 'vitest';
import type { PageView } from '../shared/messages.ts';
import type { PageText } from '../shared/page-text.ts';
import { createOverlaySync } from './overlay-sync.ts';

const TEXT: PageText = { balloons: [], looseText: [] };
const page = (anchorId: string, transcript: PageView['transcript']): PageView => ({
  anchorId,
  rect: { x: 0, y: 0, width: 430, height: 625 },
  thumbnail: 'data:',
  transcript,
});

function setup() {
  const shown: [number, string, PageText][] = [];
  const sync = createOverlaySync({ show: (tabId, anchorId, text) => void shown.push([tabId, anchorId, text]) });
  return { sync, shown };
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
});
