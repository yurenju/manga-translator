// PROTOTYPE（#14）：ルビ相關指標。用法：node score-ruby.mjs <run> [<run>...]
//
//   偵測：GT 的每個 ruby，預測的 rubyHints 裡有沒有 base 蓋到它的漢字（位置對）
//   讀對：GT 的 rt（假名正規化、片假名轉平假名）是不是同一個 Balloon 所有 hint rt 串起來的子字串
//   誤報：base 跟 GT 任何 ruby 的漢字都沒有交集的 hint
//   讀音：整句讀音（只比假名）、振り仮名命中（GT rt 有沒有出現在整句讀音裡）；義訓＝跟一般音讀／訓讀推不出來的那幾個
//   延遲：ルビ這一步的本機時間；有 LLM 的 run 再加 turn 時間、tokens、費用
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../testdata/synthetic/out");
// 從文字推不出來的讀音（義訓、人名、地名、創作讀法）。其他 ruby 都是一般讀法
const GIKUN = new Set(["マジ", "パートナー", "しおみざか", "きりしま", "みなと", "ライトニングランス", "どき"]);
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
const shares = (a, b) => [...a].some((c) => b.includes(c));

for (const run of process.argv.slice(2)) {
  const dir = join(here, "results", run);
  const recs = readdirSync(dir).filter((f) => /^p\d.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const det = [], rtOk = [], fp = [], readKana = [], rubyHit = [], gikunHit = [], misses = [];
  const lat = [], turn = [], inTok = [], outTok = [], cost = [];
  for (const rec of recs) {
    const gt = JSON.parse(readFileSync(join(dataDir, `${rec.id}.json`), "utf8"));
    const pred = rec.output.texts;
    const pairs = [];
    pred.forEach((p, pi) => gt.texts.forEach((g, gi) => pairs.push({ pi, gi, v: Math.max(iou(p.bbox, g.bbox), iou(p.bbox, g.textBbox)) })));
    pairs.sort((a, b) => b.v - a.v);
    const uP = new Set(), uG = new Set();
    for (const m of pairs) {
      if (m.v < 0.3 || uP.has(m.pi) || uG.has(m.gi)) continue;
      uP.add(m.pi); uG.add(m.gi);
      const p = pred[m.pi], g = gt.texts[m.gi];
      const hints = p.rubyHints ?? [];
      const allRt = kana(hints.map((h) => h.rt).join(""));
      for (const r of g.ruby ?? []) {
        const d = hints.some((h) => shares(h.base, r.base));
        det.push(d ? 1 : 0);
        const ok = allRt.includes(kana(r.rt));
        rtOk.push(ok ? 1 : 0);
        const hit = kana(p.reading).includes(kana(r.rt)) ? 1 : 0;
        rubyHit.push(hit);
        if (GIKUN.has(r.rt)) gikunHit.push(hit);
        if (!hit) misses.push(`${rec.id}:${r.base}→${r.rt}`);
      }
      for (const h of hints) fp.push((g.ruby ?? []).some((r) => shares(h.base, r.base)) ? 0 : 1);
      readKana.push(acc(kana(p.reading), kana(g.reading)));
    }
    if (rec.rubyLatency) lat.push(rec.rubyLatency.wallMs);
    if (rec.latency?.turnMs != null) turn.push(rec.latency.turnMs);
    if (rec.usage) { inTok.push(rec.usage.input_tokens + (rec.usage.cache_read_input_tokens ?? 0) + (rec.usage.cache_creation_input_tokens ?? 0)); outTok.push(rec.usage.output_tokens); }
    if (rec.costUsd != null) cost.push(rec.costUsd);
  }
  const r = (xs) => (xs.length ? Math.round(mean(xs)) : "—");
  console.log(`\n## ${run}  (${recs.length} 頁)`);
  console.log(`ルビ偵測 ${pct(mean(det))}｜ルビ讀對 ${pct(mean(rtOk))}（${det.length} 個）｜誤報 ${fp.reduce((a, b) => a + b, 0)}/${fp.length}`);
  console.log(`讀音（只比假名）${pct(mean(readKana))}｜振り仮名命中 ${pct(mean(rubyHit))}｜義訓命中 ${pct(mean(gikunHit))}（${gikunHit.length} 個）`);
  console.log(`ルビ本機 ms ${r(lat)}｜turn ms ${r(turn)}｜in tok ${r(inTok)}｜out tok ${r(outTok)}｜$/頁 ${cost.length ? mean(cost).toFixed(5) : "—"}`);
  console.log(`沒命中：${misses.join("、") || "（無）"}`);
}
