/**
 * 第 2 層（spec #27 第 12 節）：在外掛頁面裡對合成頁跑本機流水線（wasm），量 #7 的指標，退步就失敗。
 * 比較對象是 #7 的 browser-wasm-q8-v4s（同樣的 detector-v4-s_int8＋q8 OCR、同樣 7 張頁、p07 整張不切）。
 */
import { readFile } from 'node:fs/promises';
import type { RatioRect } from '../src/shared/page-text.ts';
import { readGroundTruth } from '../src/testing/synthetic.ts';
import { E2E_PIPELINE, expect, test } from './fixtures.ts';
import { scorePage, summarize, type Box, type Prediction } from './score.ts';

/** #7 的 7 張頁（p08 #7 沒跑；p07 是 Spread，#7 整張送）。 */
const PAGES = ['p01-basic', 'p02-ruby', 'p03-shapes', 'p04-outside', 'p05-dense', 'p06-horizontal', 'p07-spread'];

/** #7 browser-wasm-q8-v4s 的 summary（prototype/local-ocr-pipeline 的 results/browser-wasm-q8-v4s/score.json）。 */
const BASELINE = { recallOverlay: 1, ja: 0.9782798833819243, orderPairwise: 0.979591836734694 };

const SYNTHETIC = new URL('../testdata/synthetic/out/', import.meta.url);

test('合成頁上 Balloon 召回率、原文正確率、閱讀順序正確率不低於 #7', async ({ context, extensionId, mockSite }) => {
  test.setTimeout(5 * 60_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test-pipeline.html`);
  const config = E2E_PIPELINE(mockSite);

  const scores = [];
  for (const id of PAGES) {
    const dataUrl = `data:image/png;base64,${(await readFile(new URL(`${id}.png`, SYNTHETIC))).toString('base64')}`;
    const { text, width, height, ms } = await page.evaluate(([url, config]) => globalThis.__analyzeImage(url, config), [dataUrl, config] as const);
    const px = (r: RatioRect): Box => [r.x * width, r.y * height, r.w * width, r.h * height];
    const predictions: Prediction[] = [
      ...text.balloons.map((b) => ({ order: b.order, bbox: px(b.balloonBbox), ja: b.原文, reading: b.讀音 })),
      ...text.looseText.map((l) => ({ order: l.order, bbox: px(l.bbox), ja: l.原文, reading: l.讀音 })),
    ];
    const score = scorePage(readGroundTruth(id), predictions);
    console.log(
      `${id}: recall(覆蓋) ${score.recallOverlay.toFixed(3)} recall(全) ${score.recallAll.toFixed(3)} ` +
        `順序 ${score.orderPairwise?.toFixed(3) ?? '—'} 原文 ${score.ja.toFixed(3)} 讀音(kuromoji) ${score.reading.toFixed(3)} ${ms} ms` +
        (score.missed.length ? ` 漏：${score.missed.join(' / ')}` : ''),
    );
    scores.push(score);
  }
  const summary = summarize(scores);
  const status = await page.evaluate(() => globalThis.__modelStatus.at(-1));
  console.log(`平均（${JSON.stringify(status)}）：${JSON.stringify(summary)}；#7：${JSON.stringify(BASELINE)}`);

  expect(summary.recallOverlay).toBeGreaterThanOrEqual(BASELINE.recallOverlay);
  expect(summary.ja).toBeGreaterThanOrEqual(BASELINE.ja);
  expect(summary.orderPairwise).toBeGreaterThanOrEqual(BASELINE.orderPairwise);
});
