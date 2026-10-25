/**
 * 用 onnxruntime-web 跑 detector（comic-text-and-bubble-detector）與 manga-ocr（spec #27 第 3.3 節）。
 *
 * 沒用 transformers.js：它要 decoder_model_merged.onnx，onnx-community 的 manga-ocr repo 沒有（#7），
 * 所以照 prototype 自己做 greedy decoding（沒有 KV cache；原版 manga-ocr 用 beam 4）。
 *
 * onnxruntime-web 不跟著 esbuild 打包：它的 .mjs 原樣放在外掛的 ort/ 裡、執行時動態 import，
 * 這樣它用 import.meta.url 找 wasm 與開多執行緒 worker 時，指到的都是它自己的檔案。
 */
import type * as Ort from 'onnxruntime-web';
import type { ExecutionProvider } from './models/model-files.ts';
import { DETECTION_LABELS, type Detection, type Engine, type PageImage } from './pipeline/analyze.ts';
import type { PixelBox } from './pipeline/boxes.ts';

type OrtModule = typeof Ort;

const CLS = 2n;
const SEP = 3;
/** token id ≤ 4 是特殊 token（PAD／UNK／CLS／SEP／MASK）。 */
const LAST_SPECIAL = 4;
const MAX_TOKENS = 64;

let ortPromise: Promise<OrtModule> | undefined;

export function loadOrt(): Promise<OrtModule> {
  ortPromise ??= (async () => {
    const ort = (await import(chrome.runtime.getURL('ort/ort.webgpu.bundle.min.mjs'))) as OrtModule;
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
    // 多執行緒要 SharedArrayBuffer，也就是 crossOriginIsolated（manifest 的 COOP／COEP）；沒有就單執行緒。
    ort.env.wasm.numThreads = crossOriginIsolated ? navigator.hardwareConcurrency : 1;
    return ort;
  })();
  return ortPromise;
}

/** 有 WebGPU adapter 才用 WebGPU；headless 與部分 Mac 沒有，退回 wasm。 */
export async function detectExecutionProvider(): Promise<ExecutionProvider> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  try {
    return (await gpu?.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

export interface OrtEngine extends Engine {
  executionProvider: ExecutionProvider;
  threads: number;
  release(): Promise<void>;
}

export async function createOrtEngine(
  ep: ExecutionProvider,
  models: { detector: ArrayBuffer; encoder: ArrayBuffer; decoder: ArrayBuffer; vocab: string[] },
  maxThreads?: number,
): Promise<OrtEngine> {
  const ort = await loadOrt();
  if (maxThreads !== undefined) ort.env.wasm.numThreads = Math.min(ort.env.wasm.numThreads ?? 1, maxThreads);
  // wasm 在 proxy worker 裡跑：建 session（編譯、最佳化）與推論都不卡 offscreen 的主執行緒，
  // 裁切縮圖等其他訊息才不會被擋住（外掛頁面共用同一個 renderer）。WebGPU 不支援 proxy。
  // 只在第一次初始化前設定有效。
  ort.env.wasm.proxy = ep === 'wasm';
  const create =(buffer: ArrayBuffer) => ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: [ep] });
  const detector = await create(models.detector);
  const encoder = await create(models.encoder);
  const decoder = await create(models.decoder);
  const { vocab } = models;

  async function detect(image: PageImage): Promise<Detection[]> {
    const rgb = image.rgb640();
    const plane = 640 * 640;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) input[c * plane + i] = rgb[i * 3 + c]! / 255;
    const out = await detector.run({
      images: new ort.Tensor('float32', input, [1, 3, 640, 640]),
      orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from([BigInt(image.width), BigInt(image.height)]), [1, 2]),
    });
    const labels = out.labels!.data as BigInt64Array;
    const boxes = out.boxes!.data as Float32Array;
    const scores = out.scores!.data as Float32Array;
    const detections: Detection[] = [];
    for (let i = 0; i < scores.length; i++) {
      const label = DETECTION_LABELS[Number(labels[i])];
      if (!label) continue;
      const [x1, y1, x2, y2] = [boxes[i * 4]!, boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!];
      detections.push({ label, score: scores[i]!, box: [x1, y1, x2 - x1, y2 - y1].map(Math.round) as PixelBox });
    }
    return detections;
  }

  async function recognize(image: PageImage, boxes: PixelBox[]): Promise<string[]> {
    if (boxes.length === 0) return [];
    const n = boxes.length;
    const plane = 224 * 224;
    const pixels = new Float32Array(n * 3 * plane);
    boxes.forEach((box, k) => {
      const gray = image.crop224(box);
      for (let i = 0; i < plane; i++) {
        const v = (gray[i]! / 255 - 0.5) / 0.5;
        pixels[k * 3 * plane + i] = v;
        pixels[k * 3 * plane + plane + i] = v;
        pixels[k * 3 * plane + 2 * plane + i] = v;
      }
    });
    // 整頁所有框一個 batch
    const { last_hidden_state: hidden } = await encoder.run({ pixel_values: new ort.Tensor('float32', pixels, [n, 3, 224, 224]) });
    const sequences: bigint[][] = Array.from({ length: n }, () => [CLS]);
    const done = new Array<boolean>(n).fill(false);
    for (let step = 0; step < MAX_TOKENS && done.includes(false); step++) {
      const length = sequences[0]!.length;
      const ids = BigInt64Array.from(sequences.flat());
      const { logits } = await decoder.run({
        input_ids: new ort.Tensor('int64', ids, [n, length]),
        // proxy 模式會把輸入的 ArrayBuffer transfer 給 worker，每一步都要給一份新的
        encoder_hidden_states: new ort.Tensor('float32', (hidden!.data as Float32Array).slice(), hidden!.dims),
      });
      const vocabSize = logits!.dims[2]!;
      const data = logits!.data as Float32Array;
      for (let k = 0; k < n; k++) {
        if (done[k]) {
          sequences[k]!.push(0n);
          continue;
        }
        const offset = (k * length + length - 1) * vocabSize;
        let best = 0;
        let bestValue = -Infinity;
        for (let v = 0; v < vocabSize; v++) {
          if (data[offset + v]! > bestValue) {
            bestValue = data[offset + v]!;
            best = v;
          }
        }
        sequences[k]!.push(BigInt(best));
        if (best === SEP) done[k] = true;
      }
    }
    return sequences.map((seq) =>
      seq
        .slice(1)
        .map(Number)
        .filter((t) => t > LAST_SPECIAL)
        .map((t) => (vocab[t] ?? '').replace(/^##/, ''))
        .join(''),
    );
  }

  return {
    executionProvider: ep,
    threads: ort.env.wasm.numThreads ?? 1,
    detect,
    recognize,
    async release() {
      await Promise.all([detector.release(), encoder.release(), decoder.release()]);
    },
  };
}
