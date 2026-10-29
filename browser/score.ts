/**
 * 偵測／OCR／閱讀順序的評分，定義照抄 prototype/local-ocr-pipeline 的 score.mjs（#7），數字才能直接比較：
 *   配對：預測 bbox 與 ground truth 的 bbox／textBbox 取較大 IoU，IoU ≥ 0.3 才算命中，貪婪一對一
 *   召回率（覆蓋）：只算 ground truth kind ∈ {balloon, thought, narration}
 *   原文：命中者的 1 − CER（Levenshtein / ground truth 長度；NFKC、去空白）
 *   閱讀順序：命中者之間成對順序正確的比例
 */
import type { GtPage } from '../src/testing/synthetic.ts';

export type Box = [number, number, number, number];

export interface Prediction {
  order: number;
  bbox: Box;
  ja: string;
  reading: string;
}

const OVERLAY = new Set(['balloon', 'thought', 'narration']);

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
const kataToHira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const accuracy = (pred: string, gt: string) => (gt.length ? Math.max(0, 1 - levenshtein([...pred], [...gt]) / [...gt].length) : 1);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export interface PageScore {
  id: string;
  recallAll: number;
  recallOverlay: number;
  orderPairwise: number | undefined;
  ja: number;
  reading: number;
  missed: string[];
}

export function scorePage(gt: GtPage, predictions: Prediction[]): PageScore {
  const pred = [...predictions].sort((a, b) => a.order - b.order);
  const pairs: { pi: number; gi: number; iou: number }[] = [];
  pred.forEach((p, pi) =>
    gt.texts.forEach((g, gi) => pairs.push({ pi, gi, iou: Math.max(iou(p.bbox, g.bbox), iou(p.bbox, g.textBbox)) })),
  );
  pairs.sort((a, b) => b.iou - a.iou);
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const matches: typeof pairs = [];
  for (const m of pairs) {
    if (m.iou < 0.3 || usedP.has(m.pi) || usedG.has(m.gi)) continue;
    usedP.add(m.pi);
    usedG.add(m.gi);
    matches.push(m);
  }
  const overlayGt = gt.texts.filter((t) => OVERLAY.has(t.kind)).length;
  const overlayHit = matches.filter((m) => OVERLAY.has(gt.texts[m.gi]!.kind)).length;
  const ordered = [...matches].sort((a, b) => a.gi - b.gi);
  let ok = 0;
  let total = 0;
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      total++;
      if (ordered[i]!.pi < ordered[j]!.pi) ok++;
    }
  }
  return {
    id: gt.id,
    recallAll: matches.length / (gt.texts.length || 1),
    recallOverlay: overlayHit / (overlayGt || 1),
    orderPairwise: total ? ok / total : undefined,
    ja: mean(matches.map((m) => accuracy(norm(pred[m.pi]!.ja), norm(gt.texts[m.gi]!.ja)))),
    reading: mean(matches.map((m) => accuracy(kataToHira(norm(pred[m.pi]!.reading)), kataToHira(norm(gt.texts[m.gi]!.reading))))),
    missed: gt.texts.filter((_, i) => !usedG.has(i)).map((t) => `${t.id}(${t.kind}) ${t.ja}`),
  };
}

export function summarize(pages: PageScore[]) {
  return {
    recallAll: mean(pages.map((p) => p.recallAll)),
    recallOverlay: mean(pages.map((p) => p.recallOverlay)),
    orderPairwise: mean(pages.map((p) => p.orderPairwise).filter((x): x is number => x !== undefined)),
    ja: mean(pages.map((p) => p.ja)),
    reading: mean(pages.map((p) => p.reading)),
  };
}
