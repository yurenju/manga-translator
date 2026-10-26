import { describe, expect, it } from 'vitest';
import { isPageCandidate, pageCandidateRejection } from './page-candidates.ts';

const VIEWPORT = { width: 1280, height: 720 };
/** 仿 Jump+ 一頁在畫面上的大小。 */
const page = (x: number, y: number) => ({ x, y, width: 430, height: 625 });

describe('isPageCandidate', () => {
  it('完整落在 viewport 內、夠大的元素是 Page 候選', () => {
    expect(isPageCandidate(page(425, 57), VIEWPORT)).toBe(true);
  });

  it('只露出一部分的不是', () => {
    expect(isPageCandidate(page(425, 699), VIEWPORT)).toBe(false);
    expect(isPageCandidate(page(425, -300), VIEWPORT)).toBe(false);
    expect(isPageCandidate(page(1000, 57), VIEWPORT)).toBe(false);
  });

  it('超出 viewport 幾 px 內仍算完整可見', () => {
    expect(isPageCandidate(page(425, 97), VIEWPORT)).toBe(true); // 下緣 722
    expect(isPageCandidate(page(-2, 57), VIEWPORT)).toBe(true);
  });

  it('太小的元素（圖示、頭像）不是', () => {
    expect(isPageCandidate({ x: 10, y: 10, width: 120, height: 120 }, VIEWPORT)).toBe(false);
    expect(isPageCandidate({ x: 10, y: 10, width: 600, height: 90 }, VIEWPORT)).toBe(false);
  });

  it('被 overflow 裁切的祖先擋住的不是（仿 Jump+ 翻頁：隔壁頁在 viewer 外面）', () => {
    const viewer = { x: 425, y: 57, width: 430, height: 625 };
    expect(isPageCandidate(page(425, 57), VIEWPORT, [viewer])).toBe(true);
    expect(isPageCandidate(page(-5, 57), VIEWPORT, [viewer])).toBe(false);
    // 翻頁動畫中途：一半在 viewer 裡
    expect(isPageCandidate(page(640, 57), VIEWPORT, [viewer])).toBe(false);
  });

  it('不顯示的元素（rect 為 0）不是', () => {
    expect(isPageCandidate({ x: 0, y: 0, width: 0, height: 0 }, VIEWPORT)).toBe(false);
  });
});

describe('pageCandidateRejection（除錯記錄用）', () => {
  it('說明為什麼不是 Page 候選；是候選時回傳 undefined', () => {
    const viewer = { x: 425, y: 57, width: 430, height: 625 };
    expect(pageCandidateRejection(page(425, 57), VIEWPORT, [viewer])).toBeUndefined();
    expect(pageCandidateRejection({ x: 10, y: 10, width: 120, height: 120 }, VIEWPORT)).toBe('small');
    expect(pageCandidateRejection(page(425, 699), VIEWPORT)).toBe('outsideViewport');
    expect(pageCandidateRejection(page(640, 57), VIEWPORT, [viewer])).toBe('clipped');
  });
});
