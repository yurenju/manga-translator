// PROTOTYPE（#7）：score.mjs（跟 #6 共用的指標）以外的補充指標。
// 用法：node score-extra.mjs <runName> [<runName>...]
//
//   讀音（只比假名）：去掉標點、符號後再算 1 − CER，避免「讀音少了 ！？…」被當成讀錯
//   振り仮名：GT 每個 ruby（例：本気→マジ）的讀音有沒有出現在預測讀音裡
//   分類：Balloon 內 / Balloon 外（GT 的 balloon、thought 算內，其他算外）
//   延遲：本機各階段（偵測、版面、OCR、讀音）與翻譯 turn 的中位數平均
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../testdata/synthetic/out");
const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
};
const kana = (s) =>
  (s ?? "").normalize("NFKC").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[^\p{L}\p{N}ー]/gu, "");
function lev(a, b) {
  a = [...a]; b = [...b];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const acc = (p, g) => (g.length ? Math.max(0, 1 - lev(p, g) / [...g].length) : 1);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (x) => (x == null ? "—" : (100 * x).toFixed(0) + "%");
const INSIDE = new Set(["balloon", "thought"]);

for (const run of process.argv.slice(2)) {
  const dir = join(here, "results", run);
  const recs = readdirSync(dir).filter((f) => /^p\d.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const readKana = [], rubyHit = [], cls = [], lat = {};
  const conf = {};
  for (const rec of recs) {
    const gt = JSON.parse(readFileSync(join(dataDir, `${rec.id}.json`), "utf8"));
    const pred = rec.output.texts;
    // 跟 score.mjs 一樣的貪婪配對（IoU ≥ 0.3）
    const pairs = [];
    pred.forEach((p, pi) => gt.texts.forEach((g, gi) => pairs.push({ pi, gi, v: Math.max(iou(p.bbox, g.bbox), iou(p.bbox, g.textBbox)) })));
    pairs.sort((a, b) => b.v - a.v);
    const uP = new Set(), uG = new Set();
    for (const m of pairs) {
      if (m.v < 0.3 || uP.has(m.pi) || uG.has(m.gi)) continue;
      uP.add(m.pi); uG.add(m.gi);
      const p = pred[m.pi], g = gt.texts[m.gi];
      readKana.push(acc(kana(p.reading), kana(g.reading)));
      for (const r of g.ruby ?? []) rubyHit.push(kana(p.reading).includes(kana(r.rt)) ? 1 : 0);
      const ok = (p.kind === "balloon") === INSIDE.has(g.kind);
      cls.push(ok ? 1 : 0);
      const key = `${g.kind}→${p.kind}`;
      conf[key] = (conf[key] ?? 0) + 1;
    }
    for (const k of ["detectMs", "layoutMs", "ocrMs", "readingMs", "localMs", "turnMs"]) {
      const v = rec.latency[k] ?? (k === "localMs" ? rec.latency.wallMs - (rec.latency.turnMs ?? 0) : undefined);
      if (v != null) (lat[k] ??= []).push(v);
    }
  }
  const r0 = recs[0];
  console.log(`\n## ${run}  (runtime=${r0.runtime ?? "onnxruntime-node"} device=${r0.device} det=${r0.det} ocr=${r0.ocrDtype} model=${r0.model ?? "—"} reading=${r0.readingFrom ?? "kuromoji"})`);
  console.log(`讀音（只比假名） ${pct(mean(readKana))}｜振り仮名命中 ${pct(mean(rubyHit))}（${rubyHit.length} 個）｜Balloon 內外分類 ${pct(mean(cls))}`);
  console.log(`延遲平均 ms：${Object.entries(lat).map(([k, v]) => `${k} ${Math.round(mean(v))}`).join("、")}｜rss ${r0.rssPeakMB ?? "—"} MB｜載入 ${JSON.stringify(r0.loadMs ?? null)}`);
  console.log(`分類明細：${Object.entries(conf).sort().map(([k, v]) => `${k} ${v}`).join("、")}`);
}
