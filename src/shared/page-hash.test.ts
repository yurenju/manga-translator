import { describe, expect, it } from 'vitest';
import { jpeg, resize, type GrayImage } from '../testing/image-degrade.ts';
import { cropGray, readGray, readGroundTruth, SYNTHETIC_IDS } from '../testing/synthetic.ts';
import { findSamePage, hammingDistance, pageHash, SAME_PAGE_MAX_DISTANCE } from './page-hash.ts';

/** 8 張合成頁；Spread（p07、p08）切成單頁，共 10 個 Page。 */
const pages: { id: string; image: GrayImage }[] = SYNTHETIC_IDS.flatMap((id) => {
  const gt = readGroundTruth(id);
  const full = readGray(id);
  return gt.pages.length === 1 ? [{ id, image: full }] : gt.pages.map((p) => ({ id: `${id}#${p.index}`, image: cropGray(full, p.bbox) }));
});

const scale = (image: GrayImage, s: number) => resize(image, Math.round(image.width * s), Math.round(image.height * s));

/** 同一個 Page 在不同網站／畫面上可能的樣子。 */
const variants: Record<string, (image: GrayImage) => GrayImage> = {
  '縮成 0.3 倍': (i) => scale(i, 0.3),
  '縮成 0.49 倍（仿 Jump+ 顯示寬）': (i) => scale(i, 0.49),
  '放大 1.5 倍': (i) => scale(i, 1.5),
  'JPEG 品質 50': (i) => jpeg(i, 50),
  'JPEG 品質 90': (i) => jpeg(i, 90),
  '縮成 0.3 倍＋JPEG 品質 50': (i) => jpeg(scale(i, 0.3), 50),
  '四邊各少 2px 再縮 0.49 倍': (i) => scale(cropGray(i, [2, 2, i.width - 4, i.height - 4]), 0.49),
};

describe('Page 的 perceptual hash', () => {
  const hashes = pages.map((p) => pageHash(p.image));

  it('是 256 bits 的十六進位字串', () => {
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  // 全尺寸 10 頁的 JPEG 編碼是純 JS 的 CPU 計算：單獨跑約 3.5 秒，npm test 跟 Worker 測試並行時會超過預設的 5 秒
  for (const [name, degrade] of Object.entries(variants)) {
    it(`同一張合成頁${name}後，距離在門檻內`, { timeout: 15_000 }, () => {
      for (const [i, page] of pages.entries()) {
        const distance = hammingDistance(hashes[i]!, pageHash(degrade(page.image)));
        expect(distance, page.id).toBeLessThanOrEqual(SAME_PAGE_MAX_DISTANCE);
      }
    });
  }

  it('不同合成頁的距離在門檻外（Spread 的左右兩頁也是）', () => {
    for (let a = 0; a < pages.length; a++) {
      for (let b = a + 1; b < pages.length; b++) {
        expect(hammingDistance(hashes[a]!, hashes[b]!), `${pages[a]!.id} / ${pages[b]!.id}`).toBeGreaterThan(SAME_PAGE_MAX_DISTANCE);
      }
    }
  });
});

describe('findSamePage', () => {
  const zero = '0'.repeat(64);
  /** 前 n 個 bit 是 1。 */
  const ones = (n: number) => (BigInt(2 ** n - 1) << BigInt(256 - n)).toString(16).padStart(64, '0');

  it('回傳門檻內最接近的那一筆', () => {
    const entries = [{ pageHash: ones(30), name: 'far' }, { pageHash: ones(3), name: 'near' }];
    expect(findSamePage(entries, zero)?.name).toBe('near');
  });

  it('都在門檻外時回傳 undefined', () => {
    expect(findSamePage([{ pageHash: ones(SAME_PAGE_MAX_DISTANCE + 1) }], zero)).toBeUndefined();
  });
});
