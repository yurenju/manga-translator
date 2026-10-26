// offscreen document：裁切截圖、偵測＋OCR＋閱讀順序；之後還會放 hash、呼叫 LLM（spec #27 第 2 節）。
// 由 SW 在需要時用 chrome.offscreen.createDocument 建立，manifest 不必宣告。
import type { AnalyzeRequest, AnalyzeResponse, CropRequest, CropResponse, Message, PageThumb } from '../shared/messages.ts';
import type { PageText } from '../shared/page-text.ts';
import { ERASE_PADDING } from '../content/overlay-layout.ts';
import { thumbnailSize, toImageRect } from './crop.ts';
import { eraseLuminance } from './erase-color.ts';
import { createLocalPipeline } from './local-pipeline.ts';
import { createPageImage } from './page-image.ts';

/** side panel 縮圖的寬度（截圖像素）。 */
const THUMBNAIL_WIDTH = 240;

async function crop({ screenshot, viewport, candidates }: CropRequest): Promise<PageThumb[]> {
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    return await Promise.all(
      candidates.map(async (candidate) => {
        const src = toImageRect(candidate.rect, viewport, bitmap);
        const size = thumbnailSize(src, THUMBNAIL_WIDTH);
        const canvas = new OffscreenCanvas(size.width, size.height);
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, src.x, src.y, src.width, src.height, 0, 0, size.width, size.height);
        return { ...candidate, thumbnail: await toDataUrl(await canvas.convertToBlob({ type: 'image/png' })) };
      }),
    );
  } finally {
    bitmap.close();
  }
}

/** messaging 是 JSON 序列化，Blob 傳不過去，跨 context 一律用 data URL（#4）。 */
function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const pipeline = createLocalPipeline({
  onStatus(status) {
    // SW 記下最新狀態給之後打開的 side panel；已開著的 side panel 直接收到。
    chrome.runtime.sendMessage({ type: 'models:status', status } satisfies Message).catch(() => {});
  },
});

/**
 * 從截圖裁出全解析度的 Page 跑本機流水線（座標換算與縮圖相同）；順便從同一張截圖算每個 Balloon 的擦除底色
 * （原地覆蓋用，Jump+ 是 tainted canvas，content script 讀不到像素）。
 */
async function analyze({ screenshot, viewport, candidate, pipeline: config }: AnalyzeRequest): Promise<PageText> {
  if (__E2E__ && config) pipeline.configure(config);
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    const rect = toImageRect(candidate.rect, viewport, bitmap);
    const text = await pipeline.analyze(bitmap, rect);
    const image = createPageImage(bitmap, rect).gray();
    const balloons = text.balloons.map((b) => {
      const box = { x: b.textBbox.x * image.width, y: b.textBbox.y * image.height, w: b.textBbox.w * image.width, h: b.textBbox.h * image.height };
      const pad = ERASE_PADDING;
      return { ...b, eraseLuminance: eraseLuminance(image, { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad }) };
    });
    return { ...text, balloons };
  } finally {
    bitmap.close();
  }
}

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'offscreen:crop') {
    crop(message).then(
      (pages) => sendResponse({ pages } satisfies CropResponse),
      (e: unknown) => sendResponse({ error: String(e) } satisfies CropResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:analyze') {
    analyze(message).then(
      (text) => sendResponse({ text } satisfies AnalyzeResponse),
      (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) } satisfies AnalyzeResponse),
    );
    return true;
  }
  return false;
});
