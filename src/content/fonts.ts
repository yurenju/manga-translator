/**
 * 覆蓋層的字型：Noto Sans TC 700，打包進外掛（spec #27 第 7.3 節，有直書字形 ～、……）。
 * 用 @fontsource 依 unicode-range 切好的子集，只載入譯文用得到的那幾個檔。
 */

export interface FontSubset {
  /** fonts/ 底下的 woff2 檔名。 */
  file: string;
  /** 原樣的 unicode-range 描述（給 FontFace 的 unicodeRange）。 */
  unicodeRange: string;
  ranges: [number, number][];
}

/** 解析 @fontsource 的 CSS（每個 @font-face 一個子集）。 */
export function parseFontFaces(css: string): FontSubset[] {
  const faces: FontSubset[] = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1]!;
    const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(body)?.[1];
    const unicodeRange = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
    if (!file || !unicodeRange) continue;
    const ranges = unicodeRange.split(',').map((part): [number, number] => {
      const [start, end = start] = part.trim().replace(/^U\+/i, '').split('-');
      return [parseInt(start!, 16), parseInt(end!, 16)];
    });
    faces.push({ file, unicodeRange, ranges });
  }
  return faces;
}

/** 這段文字用得到的子集（依 faces 的順序）。 */
export function facesFor(text: string, faces: readonly FontSubset[]): FontSubset[] {
  const codePoints = new Set([...text].map((c) => c.codePointAt(0)!));
  return faces.filter((face) => [...codePoints].some((cp) => face.ranges.some(([start, end]) => cp >= start && cp <= end)));
}
