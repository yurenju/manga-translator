// PROTOTYPE（#14）：在本機 OCR 的文字框裡找出振り仮名（ルビ）欄，裁出來另外用 manga-ocr 讀，再對回本文。
// 用完即丟，不是正式實作。輸入是 #7 的 OCR 結果（results/<ocrRun>/），只多做ルビ這一步。
//
// 用法：node ruby.mjs <ocrRun> <newRun> [--device webgpu|cpu] [--scale 1] [ids...]
//
// 做法（直書；橫書把 x / y 對調）：
//   1. 裁出文字框（＋一點邊），二值化，去掉碰到邊的連通區塊（Balloon 外框）
//   2. x 投影切成「欄」；寬度 < 本文欄 0.6 倍、緊貼在某個本文欄右邊的窄欄 = ルビ欄
//   3. ルビ欄再用 y 投影切成「段」（段與段之間空隙 ≥ ルビ字寬的 0.6 倍）
//   4. 本文欄與ルビ段都丟給 manga-ocr（同一批）；用本文欄的字距把ルビ段的 y 範圍換成字的索引
//   5. 輸出 rubyHints（[{col, base, rt}]）與標記好的 jaRuby（例：{本気|マジ}で言ってるのか）
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../testdata/synthetic/out");
const args = process.argv.slice(2);
const ocrRun = args.shift();
const runName = args.shift();
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const device = opt("--device", "webgpu");
const scale = Number(opt("--scale", "1"));
const srcDir = join(here, "results", ocrRun);
const ids = args.length ? args : readdirSync(srcDir).filter((f) => /^p\d.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, ""));
const outDir = join(here, "results", runName);
mkdirSync(outDir, { recursive: true });

const session = (p) => ort.InferenceSession.create(join(here, "models", p), { executionProviders: [device] });
const encoder = await session("ocr/encoder_model.onnx");
const decoder = await session("ocr/decoder_model.onnx");
const vocab = readFileSync(join(here, "models/ocr/vocab.txt"), "utf8").split(/\r?\n/);

// manga-ocr greedy decoding（同 core.mjs，但吃任意數量的灰階 224×224）
async function ocrBatch(crops) {
  if (!crops.length) return [];
  const N = crops.length, S = 224 * 224;
  const pix = new Float32Array(N * 3 * S);
  crops.forEach((data, n) => {
    for (let i = 0; i < S; i++) pix[n * 3 * S + i] = pix[n * 3 * S + S + i] = pix[n * 3 * S + 2 * S + i] = (data[i] / 255 - 0.5) / 0.5;
  });
  const { last_hidden_state: enc } = await encoder.run({ pixel_values: new ort.Tensor("float32", pix, [N, 3, 224, 224]) });
  const seqs = Array.from({ length: N }, () => [2]);
  const done = new Array(N).fill(false);
  for (let step = 0; step < 48 && done.includes(false); step++) {
    const L = seqs[0].length;
    const { logits } = await decoder.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(seqs.flat().map(BigInt)), [N, L]),
      encoder_hidden_states: enc,
    });
    const V = logits.dims[2], ld = logits.data;
    for (let n = 0; n < N; n++) {
      if (done[n]) { seqs[n].push(0); continue; }
      const off = (n * L + L - 1) * V;
      let best = 0, bv = -Infinity;
      for (let v = 0; v < V; v++) if (ld[off + v] > bv) (bv = ld[off + v]), (best = v);
      seqs[n].push(best);
      if (best === 3) done[n] = true;
    }
  }
  return seqs.map((s) => s.slice(1).filter((t) => t > 4).map((t) => vocab[t].replace(/^##/, "")).join(""));
}

// 投影切段：arr[i] > 0 的連續區間，空隙 < minGap 的合併
function runs(arr, minGap = 1) {
  const out = [];
  let s = -1, lastInk = -1;
  for (let i = 0; i <= arr.length; i++) {
    const ink = i < arr.length && arr[i] > 0;
    if (ink) {
      if (s < 0) s = i;
      else if (i - lastInk - 1 >= minGap) { out.push([s, lastInk + 1]); s = i; }
      lastInk = i;
    }
  }
  if (s >= 0) out.push([s, lastInk + 1]);
  return out;
}

// 二值化＋去掉碰到邊的連通區塊（Balloon 外框、隔壁的線）
function inkMask(gray, W, H) {
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) ink[i] = gray[i] < 128 ? 1 : 0;
  const seen = new Uint8Array(W * H), stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!ink[s] || seen[s]) continue;
    const comp = [];
    let touch = false;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      comp.push(i);
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touch = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (ink[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (touch) for (const i of comp) ink[i] = 0;
  }
  return ink;
}

// 沿書寫方向投影：只看欄 [a,b) 裡的墨水
function along(ink, W, H, vertical, a, b) {
  const p = new Array(vertical ? H : W).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = vertical ? x : y;
    if (ink[y * W + x] && c >= a && c < b) p[vertical ? y : x]++;
  }
  return p;
}

// 一個文字框 → { vertical, mains: [{a,b,lo,hi}], rubies: [{col,a,b,lo,hi}] }（座標都在 crop 內）
// 直書：a,b 是 x 範圍、lo,hi 是 y 範圍；橫書反過來
function analyze(ink, W, H) {
  const tryDir = (vertical) => {
    const p = new Array(vertical ? W : H).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) p[vertical ? x : y]++;
    const cols = runs(p, 2).filter(([a, b]) => b - a >= 2);
    if (!cols.length) return null;
    const maxW = Math.max(...cols.map(([a, b]) => b - a));
    const mains = [], rubies = [];
    for (const [a, b] of cols) {
      const r = runs(along(ink, W, H, vertical, a, b), 1);
      const lo = r.length ? r[0][0] : 0, hi = r.length ? r[r.length - 1][1] : 0;
      (b - a < 0.6 * maxW ? rubies : mains).push({ a, b, lo, hi });
    }
    // 閱讀順序：直書右→左、橫書上→下
    if (vertical) mains.reverse();
    // 直書：ルビ在本文欄右邊（x 較大）；橫書：在本文行上面（y 較小）
    const attached = [];
    for (const r of rubies) {
      const m = mains
        .map((m, i) => ({ i, gap: vertical ? r.a - m.b : m.a - r.b }))
        .filter((c) => c.gap >= 0 && c.gap <= 0.5 * maxW)
        .sort((x, y) => x.gap - y.gap)[0];
      if (m) attached.push({ ...r, col: m.i });
    }
    // 「像欄」的程度：沿書寫方向越長、欄越窄越像
    const len = Math.max(...mains.map((m) => m.hi - m.lo), 1);
    return { vertical, maxW, mains, rubies: attached, shape: len / maxW };
  };
  const v = tryDir(true), h = tryDir(false);
  if (!v) return h;
  if (!h) return v;
  return v.shape >= h.shape ? v : h;
}

// ルビ欄切成段：段間空隙 ≥ 本文字寬 0.5 倍才切（同一個詞的ルビ字距很小；不同詞之間通常隔著假名）
function segments(ink, W, H, r, vertical, mainW) {
  return runs(along(ink, W, H, vertical, r.a, r.b), Math.max(2, Math.round(0.5 * mainW))).map(([lo, hi]) => ({ ...r, lo, hi }));
}

async function cropGray(buf, l, t, w, h) {
  return sharp(buf).extract({ left: l, top: t, width: w, height: h }).grayscale().raw().toBuffer();
}
// 細長的欄直接拉成正方形會變形太多：先補白邊成正方形再縮
// minSide：ルビ只有一兩個小字時，周圍多留白，不要放大到糊掉
async function to224(buf, l, t, w, h, minSide = 0) {
  // sharp 的 pipeline 順序固定（extend 在 resize 之後），所以分兩段做
  const side = Math.max(w, h, minSide);
  const sq = await sharp(buf)
    .extract({ left: l, top: t, width: w, height: h })
    .flatten({ background: "#ffffff" })
    .extend({ top: Math.floor((side - h) / 2), bottom: Math.ceil((side - h) / 2), left: Math.floor((side - w) / 2), right: Math.ceil((side - w) / 2), background: "#ffffff" })
    .png()
    .toBuffer();
  const out = sharp(sq).grayscale().resize(224, 224, { kernel: "linear" });
  if (process.env.RUBY_DEBUG) await out.clone().png().toFile(join(here, "out", `crop-${debugN++}.png`));
  return out.raw().toBuffer();
}
let debugN = 0;

const kanji = /[\p{sc=Han}々〆ヶ]/u;
// crop 內的 [a,b) × [lo,hi) 換回整頁座標，四周多留 m px
const box = (an, l, tp, W, H, s, m) => {
  const [x, y, w, h] = an.vertical ? [s.a, s.lo, s.b - s.a, s.hi - s.lo] : [s.lo, s.a, s.hi - s.lo, s.b - s.a];
  const x0 = Math.max(0, x - m), y0 = Math.max(0, y - m);
  return [l + x0, tp + y0, Math.min(W, x + w + m) - x0, Math.min(H, y + h + m) - y0];
};

for (const id of ids) {
  const rec = JSON.parse(readFileSync(join(srcDir, `${id}.json`), "utf8"));
  const gt = JSON.parse(readFileSync(join(dataDir, `${id}.json`), "utf8"));
  let buf = readFileSync(join(dataDir, `${id}.png`));
  const IW = Math.round(gt.width * scale), IH = Math.round(gt.height * scale);
  if (scale !== 1) buf = await sharp(buf).resize(IW, IH).png().toBuffer();

  const t0 = performance.now();
  const jobs = [];
  const crops = [];
  for (const t of rec.output.texts) {
    const [bx, by, bw, bh] = t.textBbox.map((v) => Math.round(v * scale));
    const pad = Math.max(3, Math.round(Math.min(bw, bh) * 0.08));
    const l = Math.max(0, bx - pad), tp = Math.max(0, by - pad);
    const W = Math.min(IW - l, bw + 2 * pad), H = Math.min(IH - tp, bh + 2 * pad);
    const ink = inkMask(await cropGray(buf, l, tp, W, H), W, H);
    const an = analyze(ink, W, H);
    const job = { t, an, segs: [], mainIdx: [], segIdx: [] };
    jobs.push(job);
    if (!an || !an.rubies.length) continue;
    // 有ルビ才逐欄 OCR 本文（要知道每欄有幾個字，才能把ルビ的位置換成字的索引）
    for (const m of an.mains) {
      job.mainIdx.push(crops.length);
      crops.push(await to224(buf, ...box(an, l, tp, W, H, m, 2)));
    }
    for (const r of an.rubies) for (const s of segments(ink, W, H, r, an.vertical, an.maxW)) {
      job.segs.push(s);
      job.segIdx.push(crops.length);
      crops.push(await to224(buf, ...box(an, l, tp, W, H, s, 1), 2 * an.maxW));
    }
  }
  const t1 = performance.now();
  const texts = await ocrBatch(crops);
  const t2 = performance.now();

  let found = 0;
  for (const job of jobs) {
    const { t, an } = job;
    t.rubyHints = [];
    t.jaRuby = t.ja;
    if (!job.segs.length) continue;
    const cols = job.mainIdx.map((i) => texts[i]);
    // 字距 = 欄長 / 字數（縦中横的 !? 會被算成 2 個字，誤差先接受）
    const marks = cols.map(() => []);
    job.segs.forEach((s, k) => {
      const rt = texts[job.segIdx[k]].replace(/[^\p{sc=Hiragana}\p{sc=Katakana}ー]/gu, "");
      if (!rt) return;
      const m = an.mains[s.col], chars = [...cols[s.col]];
      const pitch = (m.hi - m.lo) / Math.max(1, chars.length);
      let from = Math.max(0, Math.floor((s.lo - m.lo) / pitch + 0.3));
      let to = Math.min(chars.length, Math.ceil((s.hi - m.lo) / pitch - 0.3));
      // 往內縮到漢字上（ルビ通常只標漢字）
      while (from < to && !kanji.test(chars[from])) from++;
      while (to > from && !kanji.test(chars[to - 1])) to--;
      if (to <= from) to = Math.min(chars.length, from + 1);
      marks[s.col].push({ from, to, rt });
      t.rubyHints.push({ col: s.col + 1, base: chars.slice(from, to).join(""), rt });
      found++;
    });
    // 同一欄、緊鄰的漢字各自有ルビ（モノルビ，例：本→マ、気→ジ）時合併成一組，對 LLM 比較好懂
    for (const ms of marks) {
      ms.sort((a, b) => a.from - b.from);
      for (let i = ms.length - 1; i > 0; i--)
        if (ms[i - 1].to === ms[i].from) { ms[i - 1].to = ms[i].to; ms[i - 1].rt += ms[i].rt; ms.splice(i, 1); }
    }
    t.rubyHints = marks.flatMap((ms, ci) => ms.map((m) => ({ col: ci + 1, base: [...cols[ci]].slice(m.from, m.to).join(""), rt: m.rt })));
    t.columns = cols;
    t.jaRuby = cols
      .map((c, ci) => {
        const chars = [...c];
        let out = "", i = 0;
        for (const mk of marks[ci].sort((a, b) => a.from - b.from)) {
          if (mk.from < i) continue;
          out += chars.slice(i, mk.from).join("") + `{${chars.slice(mk.from, mk.to).join("")}|${mk.rt}}`;
          i = mk.to;
        }
        return out + chars.slice(i).join("");
      })
      .join("");
  }
  const t3 = performance.now();
  rec.rubyLatency = { analyzeMs: Math.round(t1 - t0), ocrMs: Math.round(t2 - t1), alignMs: Math.round(t3 - t2), wallMs: Math.round(t3 - t0), crops: crops.length };
  rec.rubyScale = scale;
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(rec, null, 2));
  console.log(`${id}: ruby ${rec.rubyLatency.wallMs}ms (analyze ${rec.rubyLatency.analyzeMs} ocr ${rec.rubyLatency.ocrMs}/${crops.length} crops) hints ${found}`);
  for (const t of rec.output.texts) if (t.rubyHints.length) console.log(`   ${t.order} ${t.jaRuby}`);
}
