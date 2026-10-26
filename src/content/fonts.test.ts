import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { facesFor, parseFontFaces } from './fonts.ts';

const CSS = `/* noto-sans-tc-[0]-700-normal */
@font-face {
  font-family: 'Noto Sans TC';
  font-weight: 700;
  src: url(./files/noto-sans-tc-0-700-normal.woff2) format('woff2'), url(./files/noto-sans-tc-0-700-normal.woff) format('woff');
  unicode-range: U+3401,U+6314-6315,U+ff5e;
}
/* noto-sans-tc-[1]-700-normal */
@font-face {
  font-family: 'Noto Sans TC';
  font-weight: 700;
  src: url(./files/noto-sans-tc-1-700-normal.woff2) format('woff2');
  unicode-range: U+0-ff;
}`;

describe('parseFontFaces', () => {
  it('取出每個子集的 woff2 檔名與 unicode-range', () => {
    expect(parseFontFaces(CSS)).toEqual([
      { file: 'noto-sans-tc-0-700-normal.woff2', unicodeRange: 'U+3401,U+6314-6315,U+ff5e', ranges: [[0x3401, 0x3401], [0x6314, 0x6315], [0xff5e, 0xff5e]] },
      { file: 'noto-sans-tc-1-700-normal.woff2', unicodeRange: 'U+0-ff', ranges: [[0, 0xff]] },
    ]);
  });
});

describe('facesFor', () => {
  it('只挑譯文裡的字用得到的子集', () => {
    const faces = parseFontFaces(CSS);
    expect(facesFor('～', faces).map((f) => f.file)).toEqual(['noto-sans-tc-0-700-normal.woff2']);
    expect(facesFor('OK～', faces).map((f) => f.file)).toEqual(['noto-sans-tc-0-700-normal.woff2', 'noto-sans-tc-1-700-normal.woff2']);
    expect(facesFor('', faces)).toEqual([]);
  });

  it('打包的 Noto Sans TC 700 涵蓋合成頁譯文用到的字', () => {
    const faces = parseFontFaces(readFileSync('node_modules/@fontsource/noto-sans-tc/700.css', 'utf8'));
    expect(faces.length).toBeGreaterThan(100);
    for (const ch of '欸～好麻煩！？……，喔OK') expect(facesFor(ch, faces), ch).not.toEqual([]);
  });
});
