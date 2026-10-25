/**
 * Page 原始像素的框 [x, y, w, h]（原點左上）。只在 offscreen 流水線內部用；
 * 對外（快取、side panel、覆蓋）一律換成 shared/page-text.ts 的 RatioRect（0～1 比例座標）。
 */
export type PixelBox = [x: number, y: number, w: number, h: number];

export const area = (b: PixelBox): number => Math.max(0, b[2]) * Math.max(0, b[3]);

export function intersection(a: PixelBox, b: PixelBox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

export function union(boxes: readonly PixelBox[]): PixelBox {
  const x1 = Math.min(...boxes.map((b) => b[0]));
  const y1 = Math.min(...boxes.map((b) => b[1]));
  const x2 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y2 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x1, y1, x2 - x1, y2 - y1];
}
