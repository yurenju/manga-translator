import { describe, expect, it } from 'vitest';
import { fitText, isVertical, layerTransform, minLayerFontPx, pageSize, separateRegions, textRegions, verticalize, type Box } from './overlay-layout.ts';

describe('verticalize（直書前的文字處理）', () => {
  it('半形 !?~, 換成全形', () => {
    expect(verticalize('欸~好麻煩,真的?')).toEqual([{ text: '欸～好麻煩，真的？', upright: false }]);
  });

  it('... 與連續的 … 換成直書的刪節號', () => {
    expect(verticalize('結果...')).toEqual([{ text: '結果……', upright: false }]);
    expect(verticalize('喂…聽得到嗎')).toEqual([{ text: '喂……聽得到嗎', upright: false }]);
  });

  it('短英數字（1～3 字）與 !? 組合縱中橫', () => {
    expect(verticalize('7點在車站前')).toEqual([
      { text: '7', upright: true },
      { text: '點在車站前', upright: false },
    ]);
    expect(verticalize('你是認真的嗎!?')).toEqual([
      { text: '你是認真的嗎', upright: false },
      { text: '！？', upright: true },
    ]);
    expect(verticalize('OK！')).toEqual([
      { text: 'OK', upright: true },
      { text: '！', upright: false },
    ]);
  });

  it('4 字以上的英數字不縱中橫', () => {
    expect(verticalize('2026年')).toEqual([{ text: '2026年', upright: false }]);
  });
});

describe('isVertical', () => {
  it('預設直書；標橫書而且 Balloon 是寬的才橫書', () => {
    expect(isVertical('vertical', { x: 0, y: 0, w: 300, h: 100 })).toBe(true);
    expect(isVertical('horizontal', { x: 0, y: 0, w: 300, h: 100 })).toBe(false);
    expect(isVertical('horizontal', { x: 0, y: 0, w: 100, h: 300 })).toBe(true);
  });
});

describe('textRegions', () => {
  // Balloon 200×400，文字框在中間 60×200
  const balloon = { x: 100, y: 100, w: 200, h: 400 };
  const text = { x: 170, y: 200, w: 60, h: 200 };

  it('擦除範圍是文字框外擴 3px', () => {
    expect(textRegions(balloon, text).erase).toEqual({ x: 167, y: 197, w: 66, h: 206 });
  });

  it('第 1 階：文字框四邊外擴 Balloon 寬高的 12%，但不超出 Balloon 往內 8%', () => {
    // 左右：170−24=146、230+24=254（都在 116～284 內）；上下：200−48=152、400+48=448（在 132～468 內）
    expect(textRegions(balloon, text).fit1).toEqual({ x: 146, y: 152, w: 108, h: 296 });
    // 文字框貼著 Balloon 邊：夾在往內 8% 的位置
    expect(textRegions(balloon, { x: 105, y: 105, w: 190, h: 390 }).fit1).toEqual({ x: 116, y: 132, w: 168, h: 336 });
  });

  it('第 2 階：Balloon 往內 10%，而且不比第 1 階小', () => {
    expect(textRegions(balloon, text).fit2).toEqual({ x: 120, y: 140, w: 160, h: 320 });
    expect(textRegions(balloon, { x: 105, y: 105, w: 190, h: 390 }).fit2).toEqual({ x: 116, y: 132, w: 168, h: 336 });
  });
});

describe('separateRegions（相鄰 Balloon 的譯文範圍不重疊）', () => {
  // 真實 Jump+ 一頁（822×1200）的偵測結果（#27 除錯 trace）：三個直書 Balloon 疊在一起，
  // 偵測框互相重疊，b7 的譯文「這個……」原本排進了 b6 的框裡
  const px = (r: Box): Box => ({ x: r.x * 822, y: r.y * 1200, w: r.w * 822, h: r.h * 1200 });
  const detected = {
    b5: { balloon: px({ x: 0.85523, y: 0.52083, w: 0.09367, h: 0.10083 }), text: px({ x: 0.87591, y: 0.53333, w: 0.05109, h: 0.0725 }) },
    b6: { balloon: px({ x: 0.73723, y: 0.53167, w: 0.17032, h: 0.19 }), text: px({ x: 0.77007, y: 0.55, w: 0.09976, h: 0.15333 }) },
    b7: { balloon: px({ x: 0.68978, y: 0.63, w: 0.10706, h: 0.1 }), text: px({ x: 0.72263, y: 0.6575, w: 0.05353, h: 0.05667 }) },
  };
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const contains = (b: Box, p: { x: number; y: number }) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

  it('重疊的 Balloon 之間，譯文範圍沿著文字框分得比較開的方向從中間切開', () => {
    const items = Object.values(detected).map(({ balloon, text }) => ({ text, ...textRegions(balloon, text) }));
    separateRegions(items);
    for (const [i, a] of items.entries()) {
      for (const b of items.slice(i + 1)) {
        expect(overlaps(a.fit1, b.fit1)).toBe(false);
        expect(overlaps(a.fit2, b.fit2)).toBe(false);
      }
      // 自己的文字框中心仍在範圍內，第 2 階仍不比第 1 階小
      expect(contains(a.fit1, center(a.text))).toBe(true);
      expect(contains(a.fit2, a.fit1) && contains(a.fit2, { x: a.fit1.x + a.fit1.w, y: a.fit1.y + a.fit1.h })).toBe(true);
    }
  });

  it('不重疊的 Balloon 不動', () => {
    const balloon = { x: 100, y: 100, w: 200, h: 400 };
    const text = { x: 170, y: 200, w: 60, h: 200 };
    const far = { x: 1000, y: 100, w: 200, h: 400 };
    const items = [
      { text, ...textRegions(balloon, text) },
      { text: { ...text, x: 1070 }, ...textRegions(far, { ...text, x: 1070 }) },
    ];
    const before = structuredClone(items);
    separateRegions(items);
    expect(items).toEqual(before);
  });
});

describe('fitText（譯文太長的三階段，spec 第 7.4 節）', () => {
  const fit1: Box = { x: 0, y: 0, w: 100, h: 100 };
  const fit2: Box = { x: 0, y: 0, w: 150, h: 150 };

  /** 假的量測：每個範圍放得下的最大字級；套到 DOM 的紀錄。 */
  function target(capacity: Map<Box, number>) {
    const applied: [Box, number][] = [];
    let current: [Box, number] = [fit1, 0];
    return {
      applied,
      apply(region: Box, size: number) {
        current = [region, size];
        applied.push(current);
      },
      overflows: () => current[1] > capacity.get(current[0])!,
    };
  }

  it('放得下就用 26px', () => {
    expect(fitText(target(new Map([[fit1, 40], [fit2, 40]])), { fit1, fit2 }, 0)).toEqual({ stage: 1, size: 26, region: fit1, truncated: false });
  });

  it('第 1 階：在文字框外擴範圍內縮到放得下（最小 14px）', () => {
    expect(fitText(target(new Map([[fit1, 16], [fit2, 40]])), { fit1, fit2 }, 0)).toEqual({ stage: 1, size: 16, region: fit1, truncated: false });
  });

  it('第 2 階：14px 還放不下就擴到 Balloon 往內 10%，最小 12px', () => {
    expect(fitText(target(new Map([[fit1, 13], [fit2, 20]])), { fit1, fit2 }, 0)).toEqual({ stage: 2, size: 20, region: fit2, truncated: false });
    expect(fitText(target(new Map([[fit1, 11], [fit2, 12]])), { fit1, fit2 }, 0)).toEqual({ stage: 2, size: 12, region: fit2, truncated: false });
  });

  it('第 3 階：還放不下就 10px 並截斷', () => {
    const t = target(new Map([[fit1, 5], [fit2, 5]]));
    expect(fitText(t, { fit1, fit2 }, 0)).toEqual({ stage: 3, size: 10, region: fit2, truncated: true });
    expect(t.applied.at(-1)).toEqual([fit2, 10]);
  });

  it('最小字級另外用畫面 px 判斷：每一階都不小於換算回 Page 像素的 9px', () => {
    // 顯示倍率 0.5：畫面 9px＝Page 18px
    const min = minLayerFontPx(0.5);
    expect(min).toBe(18);
    expect(fitText(target(new Map([[fit1, 16], [fit2, 19]])), { fit1, fit2 }, min)).toEqual({ stage: 2, size: 19, region: fit2, truncated: false });
    expect(fitText(target(new Map([[fit1, 16], [fit2, 16]])), { fit1, fit2 }, min)).toEqual({ stage: 3, size: 18, region: fit2, truncated: true });
  });

  it('不是整數的最小字級也會試到', () => {
    const min = minLayerFontPx(0.48); // 18.75
    expect(fitText(target(new Map([[fit1, 18.75], [fit2, 0]])), { fit1, fit2 }, min)).toEqual({ stage: 1, size: 18.75, region: fit1, truncated: false });
  });
});

describe('Page 層對到 anchor', () => {
  // 仿 Jump+：880×1280 的 canvas 顯示成 430 寬，在 offsetParent 裡的 (16, 40)
  const anchor = { offsetLeft: 16, offsetTop: 40, offsetWidth: 430, offsetHeight: 625.45 };
  const whole = { x: 0, y: 0, w: 1, h: 1 };

  it('Page 原始像素取自 anchor 的原圖尺寸 × subRect', () => {
    expect(pageSize({ width: 880, height: 1280 }, whole, anchor)).toEqual({ width: 880, height: 1280 });
    // Spread 的左頁
    expect(pageSize({ width: 1760, height: 1280 }, { x: 0, y: 0, w: 0.5, h: 1 }, anchor)).toEqual({ width: 880, height: 1280 });
  });

  it('不知道原圖尺寸時用畫面大小', () => {
    expect(pageSize({ width: 0, height: 0 }, whole, anchor)).toEqual({ width: 430, height: 625.45 });
  });

  it('translate 到 anchor 的 offset 位置＋subRect，scale 成畫面大小', () => {
    expect(layerTransform(anchor, whole, { width: 880, height: 1280 })).toEqual({ x: 16, y: 40, scaleX: 430 / 880, scaleY: 625.45 / 1280 });
    // Spread 的右頁（subRect x＝0.5）
    expect(layerTransform({ ...anchor, offsetWidth: 860 }, { x: 0.5, y: 0, w: 0.5, h: 1 }, { width: 880, height: 1280 })).toEqual({
      x: 16 + 430,
      y: 40,
      scaleX: 430 / 880,
      scaleY: 625.45 / 1280,
    });
  });
});
