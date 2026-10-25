// offscreen document：裁切截圖；之後還會放 hash、偵測、OCR、呼叫 LLM（spec #27 第 2 節）。
// 由 SW 在需要時用 chrome.offscreen.createDocument 建立，manifest 不必宣告。
import type { CropRequest, CropResponse, Message, PageThumb } from '../shared/messages.ts';
import { thumbnailSize, toImageRect } from './crop.ts';

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

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type !== 'offscreen:crop') return false;
  crop(message).then(
    (pages) => sendResponse({ pages } satisfies CropResponse),
    (e: unknown) => sendResponse({ error: String(e) } satisfies CropResponse),
  );
  return true;
});
