// PROTOTYPE（#7）：本機 OCR 流水線的 Node 版（= 按需啟動的本機 server 那條路）。用完即丟，不是正式實作。
// 流程在 core.mjs；這裡只負責載入模型、用 sharp 處理影像、量延遲與記憶體。
// 輸出格式跟 #6 的 results/<run>/<id>.json 相同（zh 留空，由 translate.mjs 補）。
//
// 用法：node ocr.mjs <runName> [--device cpu|dml|webgpu] [--det v4s|int8|fp32] [--ocr-dtype fp32|q8]
//                    [--order panels|naive] [--scale 1] [--repeat 3] [--thr 0.4] [ids...]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import kuromoji from "kuromoji";
import { benchPage, runPage } from "./core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../testdata/synthetic/out");

const args = process.argv.slice(2);
const runName = args.shift();
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const device = opt("--device", "cpu");
const detName = opt("--det", "v4s");
const ocrDtype = opt("--ocr-dtype", "fp32");
const orderMode = opt("--order", "panels");
const scale = Number(opt("--scale", "1"));
const repeat = Number(opt("--repeat", "3"));
const thr = Number(opt("--thr", "0.4"));
const ids = args.length
  ? args
  : readdirSync(dataDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
const outDir = join(here, "results", runName);
mkdirSync(outDir, { recursive: true });

// v4s = detector-v4-s_int8（11 MB，最新也最準）；DirectML 不支援它的 int8 op，要用 fp32
const DET_FILES = { v4s: "detector-v4-s_int8.onnx", int8: "detector_int8.onnx", fp32: "detector.onnx" };
// fp16 的 decoder ONNX 本身型別錯誤，載不起來
const OCR_SUFFIX = { fp32: "", q8: "_quantized" }[ocrDtype];

// ---------- 載入模型（冷啟動時間另外記）----------
let rssPeak = 0;
const sampleRss = () => (rssPeak = Math.max(rssPeak, process.memoryUsage().rss));
const rssTimer = setInterval(sampleRss, 20);

const session = (p) => ort.InferenceSession.create(join(here, "models", p), { executionProviders: [device] });
const tLoad0 = performance.now();
const det = await session(`detector/${DET_FILES[detName]}`);
const tDetLoaded = performance.now();
const encoder = await session(`ocr/encoder_model${OCR_SUFFIX}.onnx`);
const decoder = await session(`ocr/decoder_model${OCR_SUFFIX}.onnx`);
const vocab = readFileSync(join(here, "models/ocr/vocab.txt"), "utf8").split(/\r?\n/);
const tOcrLoaded = performance.now();
const tokenizer = await new Promise((res, rej) =>
  kuromoji.builder({ dicPath: join(here, "node_modules/kuromoji/dict") }).build((e, t) => (e ? rej(e) : res(t))),
);
const tLoaded = performance.now();
const loadMs = {
  detector: Math.round(tDetLoaded - tLoad0),
  ocr: Math.round(tOcrLoaded - tDetLoaded),
  kuromoji: Math.round(tLoaded - tOcrLoaded),
};
console.log(`load: ${JSON.stringify(loadMs)} device=${device} det=${detName} ocrDtype=${ocrDtype}`);
const models = { ort, det, encoder, decoder, vocab, tokenizer, thr, orderMode };

async function loadImage(id) {
  const gt = JSON.parse(readFileSync(join(dataDir, `${id}.json`), "utf8"));
  let buf = readFileSync(join(dataDir, `${id}.png`));
  const w = Math.round(gt.width * scale), h = Math.round(gt.height * scale);
  if (scale !== 1) buf = await sharp(buf).resize(w, h).png().toBuffer();
  return {
    w, h,
    rgb640: () => sharp(buf).removeAlpha().resize(640, 640, { fit: "fill", kernel: "linear" }).raw().toBuffer(),
    gray: () => sharp(buf).grayscale().raw().toBuffer(),
    crop224: (left, top, width, height) =>
      sharp(buf).extract({ left, top, width, height }).grayscale().resize(224, 224, { fit: "fill", kernel: "linear" }).raw().toBuffer(),
  };
}

await runPage(models, await loadImage(ids[0]));
for (const id of ids) {
  const img = await loadImage(id);
  const res = await benchPage(models, img, repeat);
  sampleRss();
  const s = (b) => b.map((v) => Math.round(v / scale));
  for (const t of res.texts) (t.bbox = s(t.bbox)), (t.textBbox = s(t.textBbox));
  const rec = {
    id, pipeline: "local-ocr", runtime: "onnxruntime-node", device, det: detName, ocrDtype, orderMode, scale, thr,
    imageSize: [img.w, img.h],
    latency: res.latency,
    loadMs,
    rssPeakMB: Math.round(rssPeak / 2 ** 20),
    usage: null,
    costUsd: 0,
    output: { texts: res.texts },
    debug: { dets: res.debug.dets.map((d) => ({ ...d, box: s(d.box) })), panels: res.debug.panels.map(s) },
  };
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(rec, null, 2));
  const l = rec.latency;
  console.log(`${id}: wall ${l.wallMs}ms (det ${l.detectMs} layout ${l.layoutMs} ocr ${l.ocrMs}/${l.ocrCrops} crops read ${l.readingMs}) texts ${rec.output.texts.length}`);
}
clearInterval(rssTimer);
console.log(`rss peak ${Math.round(rssPeak / 2 ** 20)} MB`);
