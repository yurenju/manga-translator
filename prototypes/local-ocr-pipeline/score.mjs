// PROTOTYPE（#7）：從 #6 的 prototypes/claude-vision-PROTOTYPE/score.mjs 原樣複製，指標定義保持一致，方便 #9 比較。
// 唯一改動：本機 OCR 沒有 Claude turn 時 turnMs 當 0。latency.wallMs = 整頁端到端（本機 OCR ＋ 翻譯 turn）。
// 用法：node score.mjs <runName> [<runName>...]   → 印出表格，並寫 results/<run>/score.json
//
// 指標（跟 #7 本機 OCR 實驗共用定義，方便 #9 比較）：
//   偵測：預測 bbox 與 GT 的 bbox / textBbox 取較大 IoU，IoU ≥ 0.3 視為命中，貪婪一對一配對
//         → precision / recall / F1、命中者平均 IoU、「預測框中心落在 GT 框內」比例
//         overlay = 只算 balloon / thought / narration（要原地覆蓋的種類）
//   閱讀順序：命中者之間成對順序正確的比例（pairwise accuracy）＋整頁順序完全正確與否
//   原文 / 讀音：命中者的 1 − CER（Levenshtein / GT 長度，NFKC、去空白與換行、讀音片假名轉平假名）
//   譯文：命中者與參考譯文的 chrF（字元 1–3 gram F-score，β=2，0–100），僅供相對比較
//   延遲 / 用量：來自 claude 的 result 事件
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../testdata/synthetic/out");
const OVERLAY = new Set(["balloon", "thought", "narration"]);

const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
};
const inside = ([x, y], b) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
const norm = (s) => (s ?? "").normalize("NFKC").replace(/[\s\n]/g, "");
const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
function lev(a, b) {
  a = [...a]; b = [...b];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const acc = (pred, gt) => (gt.length ? Math.max(0, 1 - lev(pred, gt) / [...gt].length) : 1);
function chrF(hyp, ref, beta = 2) {
  hyp = [...norm(hyp)]; ref = [...norm(ref)];
  let p = 0, r = 0, n = 0;
  for (let k = 1; k <= 3; k++) {
    const grams = (arr) => {
      const m = new Map();
      for (let i = 0; i + k <= arr.length; i++) { const g = arr.slice(i, i + k).join(""); m.set(g, (m.get(g) ?? 0) + 1); }
      return m;
    };
    const H = grams(hyp), R = grams(ref);
    const hc = [...H.values()].reduce((a, b) => a + b, 0), rc = [...R.values()].reduce((a, b) => a + b, 0);
    if (!hc || !rc) continue;
    let m = 0;
    for (const [g, c] of H) m += Math.min(c, R.get(g) ?? 0);
    p += m / hc; r += m / rc; n++;
  }
  if (!n) return 0;
  p /= n; r /= n;
  return p + r ? (100 * (1 + beta ** 2) * p * r) / (beta ** 2 * p + r) : 0;
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function scorePage(rec) {
  const gt = JSON.parse(readFileSync(join(dataDir, `${rec.id}.json`), "utf8"));
  const pred = (rec.output?.texts ?? []).slice().sort((a, b) => a.order - b.order);
  const pairs = [];
  for (const [pi, p] of pred.entries())
    for (const [gi, g] of gt.texts.entries())
      pairs.push({ pi, gi, iou: Math.max(iou(p.bbox, g.bbox), iou(p.bbox, g.textBbox)) });
  pairs.sort((a, b) => b.iou - a.iou);
  const usedP = new Set(), usedG = new Set(), matches = [];
  for (const m of pairs) {
    if (m.iou < 0.3 || usedP.has(m.pi) || usedG.has(m.gi)) continue;
    usedP.add(m.pi); usedG.add(m.gi); matches.push(m);
  }
  const det = (filter) => {
    const g = gt.texts.filter(filter);
    const ms = matches.filter((m) => filter(gt.texts[m.gi]));
    // overlay 的 precision 只把被預測成 overlay 種類、或配到 overlay GT 的預測算進分母
    const pCount = pred.filter((p, i) => OVERLAY.has(p.kind) || ms.some((m) => m.pi === i)).length;
    const precision = filter === all ? matches.length / (pred.length || 1) : ms.length / (pCount || 1);
    const recall = ms.length / (g.length || 1);
    return {
      gt: g.length, hit: ms.length, precision, recall,
      f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
      meanIoU: mean(ms.map((m) => m.iou)),
      centerInside: mean(ms.map((m) => {
        const p = pred[m.pi].bbox;
        return inside([p[0] + p[2] / 2, p[1] + p[3] / 2], gt.texts[m.gi].bbox) ? 1 : 0;
      })),
    };
  };
  const all = () => true;
  // 閱讀順序：依 GT 順序排列命中者，看預測順序有多少對是對的
  const ordered = matches.slice().sort((a, b) => a.gi - b.gi);
  let ok = 0, tot = 0;
  for (let i = 0; i < ordered.length; i++)
    for (let j = i + 1; j < ordered.length; j++) { tot++; if (ordered[i].pi < ordered[j].pi) ok++; }
  const perText = matches.map((m) => {
    const p = pred[m.pi], g = gt.texts[m.gi];
    return {
      gtId: g.id, kind: g.kind, predKind: p.kind, iou: +m.iou.toFixed(3),
      ja: acc(norm(p.ja), norm(g.ja)),
      reading: acc(kata2hira(norm(p.reading)), kata2hira(norm(g.reading))),
      zhChrF: chrF(p.zh, g.zh),
      orientationOk: p.orientation === g.orientation,
      predJa: p.ja, gtJa: g.ja, predZh: p.zh, gtZh: g.zh,
    };
  });
  return {
    id: rec.id,
    detectAll: det(all),
    detectOverlay: det((t) => OVERLAY.has(t.kind)),
    order: { pairwise: tot ? ok / tot : null, exact: ok === tot && matches.length === gt.texts.length },
    ja: mean(perText.map((t) => t.ja)),
    reading: mean(perText.map((t) => t.reading)),
    zhChrF: mean(perText.map((t) => t.zhChrF)),
    orientation: mean(perText.map((t) => (t.orientationOk ? 1 : 0))),
    missed: gt.texts.filter((_, i) => !usedG.has(i)).map((t) => `${t.id}(${t.kind}) ${t.ja}`),
    extra: pred.filter((_, i) => !usedP.has(i)).map((t) => `${t.kind} ${t.ja} ${JSON.stringify(t.bbox)}`),
    latency: rec.latency,
    tokens: {
      input: (rec.usage?.input_tokens ?? 0) + (rec.usage?.cache_creation_input_tokens ?? 0) + (rec.usage?.cache_read_input_tokens ?? 0),
      output: rec.usage?.output_tokens ?? 0,
    },
    costUsd: rec.costUsd,
    perText,
  };
}

const pct = (x) => (x == null ? "—" : (100 * x).toFixed(0) + "%");
for (const run of process.argv.slice(2)) {
  const dir = join(here, "results", run);
  const recs = readdirSync(dir).filter((f) => /^p\d.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const pages = recs.map(scorePage);
  const sum = {
    run,
    model: recs[0]?.model, scale: recs[0]?.scale, resident: recs[0]?.resident, notes: recs[0]?.notes,
    pages: pages.length,
    detectAllF1: mean(pages.map((p) => p.detectAll.f1)),
    detectAllRecall: mean(pages.map((p) => p.detectAll.recall)),
    detectOverlayRecall: mean(pages.map((p) => p.detectOverlay.recall)),
    meanIoU: mean(pages.map((p) => p.detectAll.meanIoU).filter((x) => x != null)),
    centerInside: mean(pages.map((p) => p.detectAll.centerInside).filter((x) => x != null)),
    orderPairwise: mean(pages.map((p) => p.order.pairwise).filter((x) => x != null)),
    orderExactPages: pages.filter((p) => p.order.exact).length,
    ja: mean(pages.map((p) => p.ja)),
    reading: mean(pages.map((p) => p.reading)),
    zhChrF: mean(pages.map((p) => p.zhChrF)),
    wallMsMean: mean(pages.map((p) => p.latency.wallMs)),
    turnMsMean: mean(pages.map((p) => p.latency.turnMs ?? 0)),
    inputTokensMean: mean(pages.map((p) => p.tokens.input)),
    outputTokensMean: mean(pages.map((p) => p.tokens.output)),
    costUsdMean: mean(pages.map((p) => p.costUsd)),
  };
  writeFileSync(join(dir, "score.json"), JSON.stringify({ summary: sum, pages }, null, 2));
  console.log(`\n## ${run}  (model=${sum.model} scale=${sum.scale} resident=${sum.resident} notes=${sum.notes})`);
  console.log("| Page | 偵測 F1 | recall(全) | recall(覆蓋) | IoU | 中心在框內 | 順序 | 原文 | 讀音 | 譯文 chrF | wall s | turn s | in tok | out tok | $ |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of pages)
    console.log(`| ${p.id} | ${pct(p.detectAll.f1)} | ${pct(p.detectAll.recall)} | ${pct(p.detectOverlay.recall)} | ${p.detectAll.meanIoU?.toFixed(2) ?? "—"} | ${pct(p.detectAll.centerInside)} | ${pct(p.order.pairwise)} | ${pct(p.ja)} | ${pct(p.reading)} | ${p.zhChrF?.toFixed(0) ?? "—"} | ${(p.latency.wallMs / 1000).toFixed(1)} | ${((p.latency.turnMs ?? 0) / 1000).toFixed(1)} | ${p.tokens.input} | ${p.tokens.output} | ${p.costUsd?.toFixed(3)} |`);
  console.log(`| **平均** | ${pct(sum.detectAllF1)} | ${pct(sum.detectAllRecall)} | ${pct(sum.detectOverlayRecall)} | ${sum.meanIoU?.toFixed(2)} | ${pct(sum.centerInside)} | ${pct(sum.orderPairwise)} | ${pct(sum.ja)} | ${pct(sum.reading)} | ${sum.zhChrF?.toFixed(0)} | ${(sum.wallMsMean / 1000).toFixed(1)} | ${(sum.turnMsMean / 1000).toFixed(1)} | ${sum.inputTokensMean.toFixed(0)} | ${sum.outputTokensMean.toFixed(0)} | ${sum.costUsdMean?.toFixed(3)} |`);
  for (const p of pages) {
    if (p.missed.length) console.log(`  ${p.id} 漏抓: ${p.missed.join(" / ")}`);
    if (p.extra.length) console.log(`  ${p.id} 多出/沒配到: ${p.extra.join(" / ")}`);
  }
}
