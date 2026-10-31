/**
 * 學習時滑鼠從句子移向 tooltip 的「譯」區塊，途中可能擦過別句的框（框常常互相重疊）。用 menu-aim 的「安全三角形」
 * 判斷滑鼠是不是正朝 tooltip 前進：是就先不換句，停在別句上夠久才換。
 */

export interface Point {
  x: number;
  y: number;
}

/** 畫面座標的矩形（DOMRect 的子集）。 */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 滑鼠停在別句上這麼久（ms）才換句：朝 tooltip 前進中途停住，就是真的想看那句。 */
export const HOVER_DWELL_MS = 300;

/** p 在三角形 abc 裡（含邊上）。 */
export function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const cross = (u: Point, v: Point, w: Point) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/**
 * 滑鼠從 from 移到 to，是不是朝 target 前進：to 落在 from 與 target 面向 from 那條邊的兩個角圍成的三角形裡。
 * from 已經在 target 裡就不算：那是要離開 target，照常換句。
 */
export function headingToward(from: Point, to: Point, target: ScreenRect): boolean {
  const { left, top, right, bottom } = target;
  const edge: [Point, Point] | undefined =
    from.y < top
      ? [{ x: left, y: top }, { x: right, y: top }]
      : from.y > bottom
        ? [{ x: left, y: bottom }, { x: right, y: bottom }]
        : from.x < left
          ? [{ x: left, y: top }, { x: left, y: bottom }]
          : from.x > right
            ? [{ x: right, y: top }, { x: right, y: bottom }]
            : undefined;
  return edge !== undefined && inTriangle(to, from, ...edge);
}
