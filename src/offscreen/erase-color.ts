/**
 * 覆蓋層的擦除底色（spec #27 第 7.2 節）：擦除範圍內「最常出現的亮度」，白底取白、黑底白字取黑。
 * 原圖像素取自截圖（Jump+ 是 tainted canvas，content script 讀不到），所以在 offscreen 算。
 */
import type { GrayImage } from './pipeline/reading-order.ts';

/** 亮度分成 16 格（每格 16 階），取像素最多的那一格的平均亮度。 */
export function eraseLuminance({ gray, width, height }: GrayImage, box: { x: number; y: number; w: number; h: number }): number {
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(width, Math.ceil(box.x + box.w));
  const bottom = Math.min(height, Math.ceil(box.y + box.h));
  const counts = new Array<number>(16).fill(0);
  const sums = new Array<number>(16).fill(0);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const v = gray[y * width + x]!;
      counts[v >> 4]!++;
      sums[v >> 4]! += v;
    }
  }
  let best = 0;
  for (let i = 1; i < 16; i++) if (counts[i]! > counts[best]!) best = i;
  // 範圍完全在圖片外：當成白底
  return counts[best] ? Math.round(sums[best]! / counts[best]!) : 255;
}
