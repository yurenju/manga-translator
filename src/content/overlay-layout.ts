/**
 * 原地覆蓋的排版規則（spec #27 第 7.3、7.4 節）。純邏輯，不碰 DOM；量測由呼叫端注入。
 * 座標與字級的單位都是 Page 原始像素（Page 層再整層 scale 到畫面上）。
 */

/** 一段譯文；upright＝縱中橫（text-combine-upright）。 */
export interface TextRun {
  text: string;
  upright: boolean;
}

const HALF_TO_FULL: Record<string, string> = { '!': '！', '?': '？', '~': '～', ',': '，' };

/** 1～3 字的英數字（前後不接英數字），或兩個全形驚嘆號／問號的組合。 */
const UPRIGHT = /(?<![0-9A-Za-z])[0-9A-Za-z]{1,3}(?![0-9A-Za-z])|[！？]{2}/g;

/** 直書前：半形 !?~, 與 ... 換成全形，短英數字縱中橫。 */
export function verticalize(text: string): TextRun[] {
  const full = text.replace(/\.{2,}|…+/g, '……').replace(/[!?~,]/g, (c) => HALF_TO_FULL[c]!);
  const runs: TextRun[] = [];
  let last = 0;
  for (const match of full.matchAll(UPRIGHT)) {
    if (match.index > last) runs.push({ text: full.slice(last, match.index), upright: false });
    runs.push({ text: match[0], upright: true });
    last = match.index + match[0].length;
  }
  if (last < full.length) runs.push({ text: full.slice(last), upright: false });
  return runs;
}

/** Page 原始像素的矩形（跟 RatioRect 同形狀，但單位是像素）。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 預設直書；只有上游標成橫書而且 Balloon 是寬的才橫書。 */
export function isVertical(orientation: 'vertical' | 'horizontal', balloon: Box): boolean {
  return !(orientation === 'horizontal' && balloon.w >= balloon.h);
}

/** 只擦文字框，外擴這麼多（不猜 Balloon 形狀，框線與尾巴保留）。 */
export const ERASE_PADDING = 3;

const fromEdges = (left: number, top: number, right: number, bottom: number): Box => ({ x: left, y: top, w: right - left, h: bottom - top });

/**
 * erase：擦除範圍；fit1：第 1 階的譯文範圍（文字框外擴 Balloon 寬高的 12%，不超出 Balloon 往內 8%）；
 * fit2：第 2 階（Balloon 往內 10%，跟 fit1 取聯集，才不會比第 1 階小）。
 */
export function textRegions(balloon: Box, text: Box): { erase: Box; fit1: Box; fit2: Box } {
  const p = ERASE_PADDING;
  const gx = balloon.w * 0.12;
  const gy = balloon.h * 0.12;
  const fit1 = fromEdges(
    Math.max(balloon.x + balloon.w * 0.08, text.x - gx),
    Math.max(balloon.y + balloon.h * 0.08, text.y - gy),
    Math.min(balloon.x + balloon.w * 0.92, text.x + text.w + gx),
    Math.min(balloon.y + balloon.h * 0.92, text.y + text.h + gy),
  );
  const fit2 = fromEdges(
    Math.min(fit1.x, balloon.x + balloon.w * 0.1),
    Math.min(fit1.y, balloon.y + balloon.h * 0.1),
    Math.max(fit1.x + fit1.w, balloon.x + balloon.w * 0.9),
    Math.max(fit1.y + fit1.h, balloon.y + balloon.h * 0.9),
  );
  return { erase: { x: text.x - p, y: text.y - p, w: text.w + 2 * p, h: text.h + 2 * p }, fit1, fit2 };
}

const boxesOverlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 對話框疊在一起時偵測框也會重疊，譯文就排進隔壁的框裡（#27 除錯在 Jump+ 看到）。兩兩比對譯文範圍，
 * 重疊就沿著兩個文字框分得比較開的那一軸，在文字框相對的兩邊中間切一刀，各留在自己那一側。
 * 只改 fit1／fit2（就地修改）；擦除範圍不動，原文還是要整個蓋掉。
 */
export function separateRegions(items: { text: Box; fit1: Box; fit2: Box }[]): void {
  for (const [i, a] of items.entries()) {
    for (const b of items.slice(i + 1)) {
      if (!boxesOverlap(a.fit2, b.fit2)) continue;
      const gapX = Math.max(b.text.x - (a.text.x + a.text.w), a.text.x - (b.text.x + b.text.w));
      const gapY = Math.max(b.text.y - (a.text.y + a.text.h), a.text.y - (b.text.y + b.text.h));
      const [pos, size] = gapX >= gapY ? (['x', 'w'] as const) : (['y', 'h'] as const);
      const mid = (t: Box) => t[pos] + t[size] / 2;
      const [first, second] = mid(a.text) <= mid(b.text) ? [a, b] : [b, a];
      // 文字框重疊很多時中點可能越過自己的文字中心，夾在兩個中心之間
      const line = Math.min(Math.max((first.text[pos] + first.text[size] + second.text[pos]) / 2, mid(first.text)), mid(second.text));
      for (const key of ['fit1', 'fit2'] as const) {
        const f = first[key];
        if (f[pos] + f[size] > line) f[size] = line - f[pos];
        const s = second[key];
        if (s[pos] < line) {
          s[size] = s[pos] + s[size] - line;
          s[pos] = line;
        }
      }
    }
  }
}

/** 最小畫面字級（畫面 px）。Jump+ 顯示倍率約 0.49×，只看 Page 像素的話 14px 在畫面上只剩約 7px。 */
export const MIN_SCREEN_FONT_PX = 9;

/** 顯示倍率（畫面 px ÷ Page 像素）下，最小畫面字級換算回 Page 像素。 */
export function minLayerFontPx(displayScale: number, minScreenPx = MIN_SCREEN_FONT_PX): number {
  return minScreenPx / displayScale;
}

/** fitText 要量的對象：把譯文套上範圍與字級，再問有沒有溢出（實際量測，不用面積估算）。 */
export interface FitTarget {
  apply(region: Box, size: number): void;
  overflows(): boolean;
}

export interface FitResult {
  stage: 1 | 2 | 3;
  size: number;
  region: Box;
  /** 第 3 階：放不下的部分截斷，滑過時 tooltip 顯示全文。 */
  truncated: boolean;
}

const START_PX = 26;
const STAGE_FLOORS = [14, 12, 10] as const;

/** 從 26px 每次 −1 縮到 floor；floor 不是整數時最後也試 floor 本身。 */
function sizesDownTo(floor: number): number[] {
  const sizes: number[] = [];
  for (let size = START_PX; size >= floor; size--) sizes.push(size);
  if (sizes.at(-1) !== floor) sizes.push(floor);
  return sizes;
}

/**
 * 三階段：1. fit1 內從 26px 縮到 14px；2. 擴到 fit2 再從 26px 縮到 12px；3. 10px 並截斷。
 * 每一階的下限都不小於 minLayerPx（最小畫面字級換算回 Page 像素）。
 */
export function fitText(target: FitTarget, regions: { fit1: Box; fit2: Box }, minLayerPx: number): FitResult {
  const stages = [
    { stage: 1 as const, region: regions.fit1, floor: Math.max(STAGE_FLOORS[0], minLayerPx) },
    { stage: 2 as const, region: regions.fit2, floor: Math.max(STAGE_FLOORS[1], minLayerPx) },
  ];
  for (const { stage, region, floor } of stages) {
    for (const size of sizesDownTo(floor)) {
      target.apply(region, size);
      if (!target.overflows()) return { stage, size, region, truncated: false };
    }
  }
  const size = Math.max(STAGE_FLOORS[2], minLayerPx);
  target.apply(regions.fit2, size);
  return { stage: 3, size, region: regions.fit2, truncated: true };
}

/** anchor 的 offset*（不含 transform；捲動、祖先 transform、overflow 裁切交給瀏覽器自然套用）。 */
export interface AnchorOffset {
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
}

/** subRect：Page 在 anchor 裡的 0～1 範圍（單頁是整個 anchor，Spread 是一半）。 */
export interface SubRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Page 原始像素：anchor 的原圖尺寸（canvas.width／img.naturalWidth）× subRect；不知道時用畫面大小。 */
export function pageSize(intrinsic: { width: number; height: number }, sub: SubRect, anchor: AnchorOffset): { width: number; height: number } {
  const width = intrinsic.width > 0 && intrinsic.height > 0 ? intrinsic.width : anchor.offsetWidth;
  const height = intrinsic.width > 0 && intrinsic.height > 0 ? intrinsic.height : anchor.offsetHeight;
  return { width: width * sub.w, height: height * sub.h };
}

/** Page 層的 transform：translate(x, y) scale(scaleX, scaleY)，transform-origin 0 0。 */
export function layerTransform(anchor: AnchorOffset, sub: SubRect, page: { width: number; height: number }) {
  return {
    x: anchor.offsetLeft + sub.x * anchor.offsetWidth,
    y: anchor.offsetTop + sub.y * anchor.offsetHeight,
    scaleX: (sub.w * anchor.offsetWidth) / page.width,
    scaleY: (sub.h * anchor.offsetHeight) / page.height,
  };
}
