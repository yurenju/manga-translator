import { describe, expect, it } from 'vitest';
import type { PixelBox } from './boxes.ts';
import { analyzePage, type Detection, type Engine, type PageImage } from './analyze.ts';

/** 1000×2000 的全白頁：整頁是背景、沒有 Panel，順序只看座標（右先、上先）。 */
function whitePage(): PageImage {
  const width = 1000;
  const height = 2000;
  return {
    width,
    height,
    rgb640: () => new Uint8Array(640 * 640 * 3).fill(255),
    gray: () => ({ gray: new Uint8Array(width * height).fill(255), width, height }),
    crop224: (box) => new Uint8Array(224 * 224).fill(box[0] % 256),
  };
}

/** 假的模型：偵測回傳固定的框；OCR 依裁切框的左緣查表。 */
function fakeEngine(detections: Detection[], textsByLeft: Record<number, string>): Engine & { crops: PixelBox[] } {
  const crops: PixelBox[] = [];
  return {
    crops,
    detect: async () => detections,
    recognize: async (_image, boxes) => {
      crops.push(...boxes);
      return boxes.map((b) => {
        const entry = Object.entries(textsByLeft).find(([left]) => Math.abs(Number(left) - b[0]) < 30);
        return entry?.[1] ?? '';
      });
    },
  };
}

const det = (label: Detection['label'], box: PixelBox, score = 0.9): Detection => ({ label, box, score });

describe('analyzePage：偵測結果 → Balloon／Loose Text', () => {
  it('Balloon 內的文字框歸到 Balloon；Balloon 外的文字是 Loose Text；座標換成 0～1 比例', async () => {
    const engine = fakeEngine(
      [
        det('bubble', [600, 100, 300, 400]),
        det('text_bubble', [700, 150, 100, 300]),
        det('text_free', [100, 1000, 200, 100]),
      ],
      { 700: '今日は', 100: 'ドドド' },
    );

    const page = await analyzePage(engine, whitePage(), (ja) => `讀音:${ja}`);

    expect(page.balloons).toEqual([
      {
        id: 'b1',
        order: 1,
        balloonBbox: { x: 0.6, y: 0.05, w: 0.3, h: 0.2 },
        textBbox: { x: 0.7, y: 0.075, w: 0.1, h: 0.15 },
        orientation: 'vertical',
        原文: '今日は',
        讀音: '讀音:今日は',
        讀音來源: 'kuromoji',
        譯文: '',
        unreadable: false,
      },
    ]);
    expect(page.looseText).toEqual([
      {
        id: 'l1',
        order: 2,
        bbox: { x: 0.1, y: 0.5, w: 0.2, h: 0.05 },
        orientation: 'horizontal',
        原文: 'ドドド',
        讀音: '讀音:ドドド',
        讀音來源: 'kuromoji',
        譯文: '',
        unreadable: false,
      },
    ]);
  });

  it('沒有文字的 Balloon（臉被當成 Balloon）與 OCR 只讀出標點的都丟掉，順序重新編號', async () => {
    const engine = fakeEngine(
      [
        det('bubble', [800, 100, 150, 150]), // 沒有文字框
        det('text_bubble', [600, 100, 50, 200]), // 只讀出「…」
        det('text_bubble', [300, 100, 50, 200]),
      ],
      { 600: '……', 300: 'はい' },
    );

    const page = await analyzePage(engine, whitePage(), (ja) => ja);

    expect(page.balloons.map((b) => [b.id, b.order, b.原文])).toEqual([['b1', 1, 'はい']]);
    expect(page.looseText).toEqual([]);
  });

  it('同類別重疊太多的框只留分數高的；分數低於門檻的不算', async () => {
    const engine = fakeEngine(
      [
        det('text_bubble', [500, 100, 100, 300], 0.9),
        det('text_bubble', [505, 110, 90, 280], 0.6),
        det('text_bubble', [100, 100, 100, 300], 0.3),
      ],
      { 500: 'ひとつ', 100: 'ふたつ' },
    );

    const page = await analyzePage(engine, whitePage(), (ja) => ja);

    expect(page.balloons.map((b) => b.原文)).toEqual(['ひとつ']);
  });

  it('OCR 的裁切範圍是文字框往外擴（短邊的 8%＋2 px），不超出 Page', async () => {
    const engine = fakeEngine([det('text_free', [0, 100, 100, 300])], { 0: 'あ' });

    await analyzePage(engine, whitePage(), (ja) => ja);

    // pad = round(100 × 0.08) + 2 = 10；左邊夾到 0，寬度維持 100＋2×10（跟 #7 的 prototype 一樣）
    expect(engine.crops).toEqual([[0, 90, 120, 320]]);
  });
});
