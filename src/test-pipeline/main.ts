// e2e build 才有（spec #27 第 12 節第 2 層）：在外掛頁面裡對整張合成頁跑同一條本機流水線，
// 讓 browser/ocr-accuracy.spec.ts 量 #7 的指標；browser/record-ocr.spec.ts 也用它錄 FakeEngine 重播的結果（rect＝Spread 的一頁）。跟 offscreen document 一樣是外掛 origin，CSP、COEP、Cache Storage 都相同。
import type { ModelStatus, PipelineConfig } from '../shared/messages.ts';
import type { PageText } from '../shared/page-text.ts';
import { createLocalPipeline } from '../offscreen/local-pipeline.ts';

declare global {
  var __analyzeImage: (
    url: string,
    config: PipelineConfig,
    rect?: { x: number; y: number; width: number; height: number },
  ) => Promise<{ text: PageText; width: number; height: number; ms: number }>;
  var __modelStatus: ModelStatus[];
}

globalThis.__modelStatus = [];
const pipeline = createLocalPipeline({ onStatus: (status) => globalThis.__modelStatus.push(status) });

globalThis.__analyzeImage = async (url, config, rect) => {
  pipeline.configure(config);
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  try {
    const start = performance.now();
    const text = await pipeline.analyze(bitmap, rect ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height });
    return { text, width: bitmap.width, height: bitmap.height, ms: Math.round(performance.now() - start) };
  } finally {
    bitmap.close();
  }
};
