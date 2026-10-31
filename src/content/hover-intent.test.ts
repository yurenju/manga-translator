import { describe, expect, it } from 'vitest';
import { headingToward, inTriangle } from './hover-intent.ts';

describe('inTriangle', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  const c = { x: 0, y: 10 };

  it('裡面、邊上、頂點都算', () => {
    expect(inTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true);
    expect(inTriangle({ x: 5, y: 5 }, a, b, c)).toBe(true);
    expect(inTriangle(a, a, b, c)).toBe(true);
  });

  it('外面不算，頂點順序不影響', () => {
    expect(inTriangle({ x: 6, y: 6 }, a, b, c)).toBe(false);
    expect(inTriangle({ x: 6, y: 6 }, a, c, b)).toBe(false);
    expect(inTriangle({ x: 2, y: 2 }, a, c, b)).toBe(true);
  });
});

describe('headingToward', () => {
  // tooltip 在句子的框下方
  const tip = { left: 320, top: 410, right: 640, bottom: 600 };

  it('從框的左下往 tooltip 斜下移（途中擦過左下那句的框），算朝 tooltip 前進', () => {
    expect(headingToward({ x: 400, y: 380 }, { x: 396, y: 386 }, tip)).toBe(true);
  });

  it('往旁邊或往回移不算', () => {
    expect(headingToward({ x: 400, y: 380 }, { x: 390, y: 380 }, tip)).toBe(false);
    expect(headingToward({ x: 400, y: 380 }, { x: 400, y: 370 }, tip)).toBe(false);
  });

  it('斜得超出 tooltip 的左邊界不算', () => {
    expect(headingToward({ x: 330, y: 380 }, { x: 320, y: 382 }, tip)).toBe(false);
  });

  it('tooltip 在上方時看下緣；在左右兩側時看相鄰那條邊', () => {
    const above = { left: 0, top: 0, right: 100, bottom: 50 };
    expect(headingToward({ x: 50, y: 80 }, { x: 50, y: 70 }, above)).toBe(true);
    expect(headingToward({ x: 50, y: 80 }, { x: 50, y: 90 }, above)).toBe(false);
    const right = { left: 200, top: 0, right: 300, bottom: 100 };
    expect(headingToward({ x: 150, y: 50 }, { x: 160, y: 50 }, right)).toBe(true);
    expect(headingToward({ x: 150, y: 50 }, { x: 140, y: 50 }, right)).toBe(false);
  });

  it('從 tooltip 裡往外移不算（要離開 tooltip）', () => {
    expect(headingToward({ x: 400, y: 500 }, { x: 0, y: 0 }, tip)).toBe(false);
  });
});
