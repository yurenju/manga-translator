import { describe, expect, it } from 'vitest';
import { subImageRect, thumbnailSize, toImageRect, toSubRect } from './crop.ts';

describe('toImageRect', () => {
  it('DPR 1：截圖像素等於 CSS px', () => {
    const rect = { x: 425, y: 57, width: 430, height: 625 };
    expect(toImageRect(rect, { width: 1280, height: 720 }, { width: 1280, height: 720 })).toEqual({
      x: 425,
      y: 57,
      width: 430,
      height: 625,
    });
  });

  it('DPR 1.5：依截圖與 viewport 的比例放大', () => {
    const rect = { x: 425, y: 57.25, width: 430, height: 625.5 };
    expect(toImageRect(rect, { width: 1280, height: 1400 }, { width: 1920, height: 2100 })).toEqual({
      x: 638,
      y: 86,
      width: 645,
      height: 938,
    });
  });

  it('容許範圍內超出 viewport 的部分夾回截圖範圍內', () => {
    const rect = { x: -2, y: 100, width: 430, height: 622 };
    expect(toImageRect(rect, { width: 1280, height: 720 }, { width: 1280, height: 720 })).toEqual({
      x: 0,
      y: 100,
      width: 428,
      height: 620,
    });
  });
});

describe('thumbnailSize', () => {
  it('縮到指定寬度並保持比例', () => {
    expect(thumbnailSize({ width: 645, height: 938 }, 160)).toEqual({ width: 160, height: 233 });
  });

  it('本來就比較小就不放大', () => {
    expect(thumbnailSize({ width: 100, height: 150 }, 160)).toEqual({ width: 100, height: 150 });
  });
});

describe('Spread 的 subRect', () => {
  it('切頁結果（候選裡的像素）換成相對候選的比例', () => {
    expect(toSubRect({ x: 1558, y: 120, width: 1558, height: 2172 }, { width: 3116, height: 2412 })).toEqual({
      x: 0.5,
      y: 120 / 2412,
      w: 0.5,
      h: 2172 / 2412,
    });
  });

  it('比例換回截圖上的像素：本機流水線裁出跟切頁時同一塊', () => {
    const candidate = { x: 10, y: 20, width: 3116, height: 2412 };
    const page = { x: 1558, y: 120, width: 1558, height: 2172 };
    expect(subImageRect(candidate, toSubRect(page, candidate))).toEqual({ x: 1568, y: 140, width: 1558, height: 2172 });
  });
});
