import { describe, expect, it } from 'vitest';
import { readGray, readGroundTruth } from '../testing/synthetic.ts';
import { eraseLuminance } from './erase-color.ts';

describe('eraseLuminance（擦除底色＝範圍內最常出現的亮度）', () => {
  it('白底黑字取白，黑底白字取黑', () => {
    // 10×10：底色 250，中間 4×4 是字（20）
    const gray = new Uint8Array(100).fill(250);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) gray[y * 10 + x] = 20;
    const image = { gray, width: 10, height: 10 };
    expect(eraseLuminance(image, { x: 0, y: 0, w: 10, h: 10 })).toBe(250);
    const inverted = { gray: gray.map((v) => 255 - v), width: 10, height: 10 };
    expect(eraseLuminance(inverted, { x: 0, y: 0, w: 10, h: 10 })).toBe(5);
  });

  it('範圍超出圖片時只看圖片內的像素', () => {
    const image = { gray: new Uint8Array(100).fill(200), width: 10, height: 10 };
    expect(eraseLuminance(image, { x: -3, y: 8, w: 20, h: 10 })).toBe(200);
  });

  it('合成頁 p03：黑底白字的 Balloon 取到暗色，其他 Balloon 取到亮色', () => {
    const page = readGray('p03-shapes');
    const raw = readGroundTruth('p03-shapes').texts as unknown as { id: string; kind: string; shape: string; textBbox: number[] }[];
    const balloons = raw.filter((t) => t.kind === 'balloon' || t.kind === 'thought');
    expect(balloons.some((t) => t.shape === 'inverted')).toBe(true);
    for (const t of balloons) {
      const [x, y, w, h] = t.textBbox as [number, number, number, number];
      const lum = eraseLuminance(page, { x: x - 3, y: y - 3, w: w + 6, h: h + 6 });
      if (t.shape === 'inverted') expect(lum, t.id).toBeLessThan(64);
      else expect(lum, t.id).toBeGreaterThan(192);
    }
  });
});
