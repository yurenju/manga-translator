// PROTOTYPE（#7）：本機 OCR 流水線的核心邏輯，Node（ocr.mjs）與瀏覽器（browser.html）共用。
// 影像處理（縮放、裁切、灰階）由呼叫端提供，因為 Node 用 sharp、瀏覽器用 canvas。
//
// 流程：偵測（comic-text-and-bubble-detector）→ 分組成 Balloon / Balloon 外文字 →
//       閱讀順序（flood fill 找 Panel ＋ XY-cut）→ OCR（manga-ocr，greedy decoding）→ 讀音（kuromoji）

export const LABELS = ["bubble", "text_bubble", "text_free"];

const area = (b) => Math.max(0, b[2]) * Math.max(0, b[3]);
const inter = (a, b) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
};
const union = (bs) => {
  const x1 = Math.min(...bs.map((b) => b[0])), y1 = Math.min(...bs.map((b) => b[1]));
  const x2 = Math.max(...bs.map((b) => b[0] + b[2])), y2 = Math.max(...bs.map((b) => b[1] + b[3]));
  return [x1, y1, x2 - x1, y2 - y1];
};
export const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// ---------- 1. 偵測 ----------
// rgb640：640×640 RGB（Uint8，HWC）。模型已內含後處理，boxes 是原圖像素的 xyxy。
async function detect({ ort, det, thr }, rgb640, w, h) {
  const f = new Float32Array(3 * 640 * 640);
  for (let i = 0; i < 640 * 640; i++) for (let c = 0; c < 3; c++) f[c * 640 * 640 + i] = rgb640[i * 3 + c] / 255;
  const out = await det.run({
    images: new ort.Tensor("float32", f, [1, 3, 640, 640]),
    orig_target_sizes: new ort.Tensor("int64", BigInt64Array.from([BigInt(w), BigInt(h)]), [1, 2]),
  });
  const labels = out.labels.data, boxes = out.boxes.data, scores = out.scores.data;
  const dets = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < thr) continue;
    const [x1, y1, x2, y2] = [boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]];
    dets.push({ label: LABELS[Number(labels[i])], score: scores[i], box: [x1, y1, x2 - x1, y2 - y1].map(Math.round) });
  }
  return nms(dets);
}
// 同類別重疊太多的框只留分數高的
function nms(dets) {
  dets.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of dets)
    if (!keep.some((k) => k.label === d.label && inter(k.box, d.box) / Math.min(area(k.box), area(d.box)) > 0.7)) keep.push(d);
  return keep;
}

// ---------- 2. 分組：文字框歸到所在的 Balloon ----------
function group(dets) {
  const bubbles = dets.filter((d) => d.label === "bubble").map((d) => ({ ...d, texts: [] }));
  const free = [];
  for (const t of dets.filter((d) => d.label !== "bubble")) {
    let best = null, bestC = 0;
    for (const b of bubbles) {
      const c = inter(t.box, b.box) / area(t.box);
      if (c > bestC) (best = b), (bestC = c);
    }
    if (best && bestC >= 0.5) best.texts.push(t);
    else free.push(t);
  }
  const units = [];
  // 沒有文字框的 Balloon 丟掉（合成頁的圓臉常被當成 Balloon）
  for (const b of bubbles.filter((b) => b.texts.length))
    units.push({ kind: "balloon", bbox: b.box, textBbox: union(b.texts.map((t) => t.box)), src: "bubble" });
  for (const t of free)
    units.push({ kind: t.label === "text_bubble" ? "balloon" : "outside", bbox: t.box, textBbox: t.box, src: t.label });
  return units;
}

// ---------- 3. 閱讀順序：找 Panel，Panel 依日漫順序排，Panel 內由右而左 ----------
// Panel 偵測：從頁緣 flood fill 白色背景（頁邊＋格間空白都連得到），
// 剩下的大塊連通區域就是 Panel（斜切格線也成立）；再對 Panel bbox 做 XY-cut 排序。
function findPanels(gray, w, h) {
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => { if (!bg[i] && gray[i] >= 200) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  for (let s = 0; s < w * h; s++) {
    if (bg[s] || label[s] >= 0) continue;
    const id = comps.length;
    let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    label[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
        if (j >= 0 && j < w * h && !bg[j] && label[j] < 0) { label[j] = id; stack.push(j); }
    }
    comps.push({ id, n, bbox: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] });
  }
  const panels = comps.filter((c) => c.n >= 0.01 * w * h);
  return { panels: xyOrder(panels), label };
}
// 對一組框做 XY-cut：先找水平空隙（上→下），再找垂直空隙（右→左）；切不開就依上緣、右緣排序
function xyOrder(items) {
  if (items.length <= 1) return items;
  const split = (lo, hi) => {
    const iv = items.map((it) => [lo(it.bbox), hi(it.bbox), it]).sort((a, b) => a[0] - b[0]);
    const groups = [];
    let cur = [], end = -Infinity;
    for (const [a, b, it] of iv) {
      // 允許 15px 的重疊（斜切格線的 bbox 會互相咬到一點）
      if (cur.length && a >= end - 15) { groups.push(cur); cur = []; }
      cur.push(it); end = Math.max(end, b);
    }
    groups.push(cur);
    return groups;
  };
  const rows = split((b) => b[1], (b) => b[1] + b[3]);
  if (rows.length > 1) return rows.flatMap(xyOrder);
  const cols = split((b) => b[0], (b) => b[0] + b[2]);
  if (cols.length > 1) return cols.reverse().flatMap(xyOrder);
  return items.slice().sort((a, b) => a.bbox[1] - b.bbox[1] || b.bbox[0] + b.bbox[2] - (a.bbox[0] + a.bbox[2]));
}
function orderUnits(units, { panels, label }, w, orderMode) {
  const rank = new Map(panels.map((p, i) => [p.id, i]));
  for (const u of units) {
    const cx = Math.round(u.bbox[0] + u.bbox[2] / 2), cy = Math.round(u.bbox[1] + u.bbox[3] / 2);
    let pi = rank.get(label[cy * w + cx]);
    if (pi == null) {
      // 中心落在格間空白（橫跨格線的 Balloon）或小區塊：歸到重疊最多的 Panel
      let best = 0;
      panels.forEach((p, i) => { const a = inter(p.bbox, u.bbox); if (a > best) (best = a), (pi = i); });
    }
    u.panel = orderMode === "naive" ? 0 : pi ?? panels.length;
  }
  // 同一 Panel 內：右邊先讀；右緣差不多（< 1/3 寬）時上面先讀
  units.sort((a, b) => {
    if (a.panel !== b.panel) return a.panel - b.panel;
    if (orderMode === "naive") {
      // 不看 Panel：先依 y 分帶（每 200px），再右到左
      const band = (u) => Math.floor((u.bbox[1] + u.bbox[3] / 2) / 200);
      if (band(a) !== band(b)) return band(a) - band(b);
    }
    const ra = a.bbox[0] + a.bbox[2], rb = b.bbox[0] + b.bbox[2];
    const tol = Math.min(a.bbox[2], b.bbox[2]) / 3;
    if (Math.abs(ra - rb) > tol) return rb - ra;
    return a.bbox[1] - b.bbox[1];
  });
  units.forEach((u, i) => (u.order = i + 1));
}

// ---------- 4. OCR ----------
// manga-ocr：灰階→RGB、224×224、(x/255−0.5)/0.5；decoder 從 [CLS]=2 開始，[SEP]=3 結束。
// transformers.js v4 要 decoder_model_merged.onnx，onnx-community 的 repo 沒有，所以自己做
// greedy decoding（沒有 KV cache，每步重算整段；原版 manga-ocr 用 beam search 4）。
async function recognize({ ort, encoder, decoder, vocab }, crop224, w, h, units) {
  if (!units.length) return;
  const N = units.length, S = 224 * 224;
  const pix = new Float32Array(N * 3 * S);
  for (const [n, u] of units.entries()) {
    const [x, y, bw, bh] = u.textBbox;
    const pad = Math.round(Math.min(bw, bh) * 0.08) + 2;
    const left = Math.max(0, x - pad), top = Math.max(0, y - pad);
    const width = Math.min(w - left, bw + 2 * pad), height = Math.min(h - top, bh + 2 * pad);
    const data = await crop224(left, top, width, height);
    for (let i = 0; i < S; i++) {
      const v = (data[i] / 255 - 0.5) / 0.5;
      pix[n * 3 * S + i] = pix[n * 3 * S + S + i] = pix[n * 3 * S + 2 * S + i] = v;
    }
  }
  const { last_hidden_state: enc } = await encoder.run({ pixel_values: new ort.Tensor("float32", pix, [N, 3, 224, 224]) });
  const seqs = Array.from({ length: N }, () => [2]);
  const done = new Array(N).fill(false);
  for (let step = 0; step < 64 && done.includes(false); step++) {
    const L = seqs[0].length;
    const ids = BigInt64Array.from(seqs.flat().map(BigInt));
    const { logits } = await decoder.run({ input_ids: new ort.Tensor("int64", ids, [N, L]), encoder_hidden_states: enc });
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
  units.forEach((u, n) => {
    u.ja = seqs[n].slice(1).filter((t) => t > 4).map((t) => vocab[t].replace(/^##/, "")).join("");
  });
}

// ---------- 5. 讀音 ----------
function reading(tokenizer, ja) {
  return tokenizer
    .tokenize(ja)
    .map((t) => (t.reading && t.reading !== "*" ? kata2hira(t.reading) : t.surface_form))
    .join("");
}

// ---------- 整頁 ----------
// models = { ort, det, encoder, decoder, vocab, tokenizer, thr, orderMode }
// img = { w, h, rgb640(): Uint8 RGB 640×640, gray(): Uint8 w×h, crop224(left, top, width, height): Uint8 灰階 224×224 }
export async function runPage(models, img) {
  const { w, h } = img;
  const t0 = performance.now();
  const dets = await detect(models, await img.rgb640(), w, h);
  const t1 = performance.now();
  const units = group(dets);
  const layout = findPanels(await img.gray(), w, h);
  orderUnits(units, layout, w, models.orderMode);
  const t2 = performance.now();
  await recognize(models, img.crop224, w, h, units);
  const t3 = performance.now();
  // 只有標點（例如臉被當成 Balloon 而 OCR 出 ...）的不算文字
  const kept = units.filter((u) => /[\p{L}\p{N}]/u.test(u.ja));
  kept.forEach((u, i) => {
    u.order = i + 1;
    u.reading = reading(models.tokenizer, u.ja);
    u.orientation = u.textBbox[3] >= u.textBbox[2] ? "vertical" : "horizontal";
  });
  const t4 = performance.now();
  return {
    latency: {
      wallMs: Math.round(t4 - t0),
      detectMs: Math.round(t1 - t0),
      layoutMs: Math.round(t2 - t1),
      ocrMs: Math.round(t3 - t2),
      readingMs: Math.round(t4 - t3),
      ocrCrops: units.length,
    },
    texts: kept.map((u) => ({
      order: u.order, kind: u.kind, bbox: u.bbox, textBbox: u.textBbox, orientation: u.orientation,
      ja: u.ja, reading: u.reading, zh: "", src: u.src,
    })),
    debug: { dets: dets.map((d) => ({ ...d, score: +d.score.toFixed(3) })), panels: layout.panels.map((p) => p.bbox) },
  };
}

// 先暖機一次（第一次跑 GPU / WebGPU 會編 shader），之後每頁跑 repeat 次取延遲中位數
export async function benchPage(models, img, repeat) {
  const runs = [];
  for (let i = 0; i < repeat; i++) runs.push(await runPage(models, img));
  const res = runs[runs.length - 1];
  const med = (k) => { const v = runs.map((r) => r.latency[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  for (const k of ["wallMs", "detectMs", "layoutMs", "ocrMs", "readingMs"]) res.latency[k] = med(k);
  res.latency.runs = runs.map((r) => r.latency.wallMs);
  return res;
}
