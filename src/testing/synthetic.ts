/**
 * 測試用：讀 testdata/synthetic/out 的合成頁與 ground truth（Node）。
 * PNG 只需要支援合成頁用的格式：8-bit RGB／RGBA、非交錯。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const OUT_DIR = new URL('../../testdata/synthetic/out/', import.meta.url);

/** ground truth 的座標都是 PNG 像素 [x, y, w, h]。 */
export type GtBox = [number, number, number, number];

export interface GtText {
  id: string;
  kind: 'balloon' | 'thought' | 'narration' | 'sfx' | 'sign' | 'outside';
  page: number | null;
  order: number;
  orientation: 'vertical' | 'horizontal';
  bbox: GtBox;
  textBbox: GtBox;
  ja: string;
  reading: string;
  zh: string;
}

export interface GtPage {
  id: string;
  width: number;
  height: number;
  pages: { index: number; bbox: GtBox }[];
  texts: GtText[];
}

export const SYNTHETIC_IDS = [
  'p01-basic',
  'p02-ruby',
  'p03-shapes',
  'p04-outside',
  'p05-dense',
  'p06-horizontal',
  'p07-spread',
  'p08-action',
] as const;

export function readGroundTruth(id: string): GtPage {
  return JSON.parse(readFileSync(new URL(`${id}.json`, OUT_DIR), 'utf8')) as GtPage;
}

/** 解出灰階（0.299/0.587/0.114，跟 offscreen 的 canvas 版一致）。 */
export function readGray(id: string): { gray: Uint8Array; width: number; height: number } {
  const png = readFileSync(new URL(`${id}.png`, OUT_DIR));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || png[28] !== 0) {
    throw new Error(`unsupported PNG ${id}: depth ${bitDepth} color ${colorType}`);
  }
  const channels = colorType === 2 ? 3 : 4;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + i] = (line[i]! + predictor) & 0xff;
    }
  }
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    gray[i] = Math.round(0.299 * pixels[p]! + 0.587 * pixels[p + 1]! + 0.114 * pixels[p + 2]!);
  }
  return { gray, width, height };
}

/** 從灰階裁出一塊（Spread 切成單頁用）。 */
export function cropGray(
  { gray, width }: { gray: Uint8Array; width: number },
  [x, y, w, h]: GtBox,
): { gray: Uint8Array; width: number; height: number } {
  const out = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) out.set(gray.subarray((y + row) * width + x, (y + row) * width + x + w), row * w);
  return { gray: out, width: w, height: h };
}
