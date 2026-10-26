/**
 * 測試用：模擬同一個 Page 在不同網站／畫面上的樣子（縮放、JPEG 壓縮），給 perceptual hash 的單元測試與量測用。
 * 只處理灰階；JPEG 只模擬它失真的那一步（8×8 DCT＋標準亮度量化表依品質縮放＋取整），不做熵編碼。
 */
import type { GrayImage } from '../shared/page-hash.ts';

export type { GrayImage };

/** 雙線性縮放（放大與小幅縮小）；縮小超過一半時先做區塊平均，跟瀏覽器高品質縮圖的效果相近。 */
export function resize(image: GrayImage, width: number, height: number): GrayImage {
  let src = image;
  while (src.width >= width * 2 && src.height >= height * 2) src = halve(src);
  const out = new Uint8Array(width * height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), src.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, src.height - 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), src.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, src.width - 1);
      const tx = fx - x0;
      const g = (xx: number, yy: number) => src.gray[yy * src.width + xx]!;
      const top = g(x0, y0) * (1 - tx) + g(x1, y0) * tx;
      const bottom = g(x0, y1) * (1 - tx) + g(x1, y1) * tx;
      out[y * width + x] = Math.round(top * (1 - ty) + bottom * ty);
    }
  }
  return { gray: out, width, height };
}

function halve(image: GrayImage): GrayImage {
  const width = Math.floor(image.width / 2);
  const height = Math.floor(image.height / 2);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 2 * y * image.width + 2 * x;
      out[y * width + x] = (image.gray[i]! + image.gray[i + 1]! + image.gray[i + image.width]! + image.gray[i + image.width + 1]! + 2) >> 2;
    }
  }
  return { gray: out, width, height };
}

/** JPEG 標準（Annex K）的亮度量化表。 */
const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100,
  103, 99,
];

const COS = Array.from({ length: 64 }, (_, i) => Math.cos(((2 * (i >> 3) + 1) * (i & 7) * Math.PI) / 16));
const C = (u: number) => (u === 0 ? Math.SQRT1_2 : 1);

/** quality 1–100，量化表的縮放方式跟 libjpeg 一樣。 */
export function jpeg(image: GrayImage, quality: number): GrayImage {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  const q = LUMA_QUANT.map((v) => Math.min(Math.max(Math.floor((v * scale + 50) / 100), 1), 255));
  const { width, height } = image;
  const out = new Uint8Array(width * height);
  const block = new Float64Array(64);
  const coef = new Float64Array(64);
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let i = 0; i < 64; i++) {
        // 邊緣不滿 8×8 時重複最後一個像素（跟 libjpeg 一樣）
        const x = Math.min(bx + (i & 7), width - 1);
        const y = Math.min(by + (i >> 3), height - 1);
        block[i] = image.gray[y * width + x]! - 128;
      }
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          let sum = 0;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += block[y * 8 + x]! * COS[x * 8 + u]! * COS[y * 8 + v]!;
          const k = v * 8 + u;
          coef[k] = Math.round((0.25 * C(u) * C(v) * sum) / q[k]!) * q[k]!;
        }
      }
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          let sum = 0;
          for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) sum += C(u) * C(v) * coef[v * 8 + u]! * COS[x * 8 + u]! * COS[y * 8 + v]!;
          if (bx + x < width && by + y < height) out[(by + y) * width + bx + x] = Math.min(Math.max(Math.round(sum / 4 + 128), 0), 255);
        }
      }
    }
  }
  return { gray: out, width, height };
}
