// offscreen document：裁切截圖、Page hash、偵測＋OCR＋閱讀順序、呼叫 LLM（spec #27 第 2 節）。
// 由 SW 在需要時用 chrome.offscreen.createDocument 建立，manifest 不必宣告。
import { SYNTHETIC_GROUND_TRUTH } from '../background/synthetic-ground-truth.ts';
import { indexedDbApiKeyStore } from '../shared/api-key-store.ts';
import { createFakeTranslator } from '../shared/fake-translator.ts';
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  CropRequest,
  CropResponse,
  FakeTranslatorConfig,
  Message,
  PageThumb,
  Rect,
  TestConnectionResponse,
  TranslateResponse,
} from '../shared/messages.ts';
import { pageHash, type GrayImage } from '../shared/page-hash.ts';
import type { PageText } from '../shared/page-text.ts';
import type { TranslateInput, TranslateOutput } from '../shared/translator.ts';
import { createClaudeTranslator } from './claude-translator.ts';
import { thumbnailSize, toImageRect } from './crop.ts';
import { createLocalPipeline } from './local-pipeline.ts';

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
        const thumbnail = await toDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
        return { ...candidate, thumbnail, pageHash: pageHash(grayOf(bitmap, src)) };
      }),
    );
  } finally {
    bitmap.close();
  }
}

/** 全解析度的裁切轉灰階（0.299/0.587/0.114，跟本機流水線一致）。縮小交給 pageHash 自己做，Node 的單元測試才算得一樣。 */
function grayOf(bitmap: ImageBitmap, rect: Rect): GrayImage {
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const { data } = ctx.getImageData(0, 0, rect.width, rect.height);
  const gray = new Uint8Array(rect.width * rect.height);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!);
  return { gray, width: rect.width, height: rect.height };
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

/** 從截圖裁出全解析度的 Page 跑本機流水線（座標換算與縮圖相同）。 */
async function analyze({ screenshot, viewport, candidate, pipeline: config }: AnalyzeRequest): Promise<PageText> {
  if (__E2E__ && config) pipeline.configure(config);
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    return await pipeline.analyze(bitmap, toImageRect(candidate.rect, viewport, bitmap));
  } finally {
    bitmap.close();
  }
}

const apiKeys = indexedDbApiKeyStore();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** API key 只在這裡讀出來、只送到 api.anthropic.com（spec 第 5 節）。 */
async function claude() {
  const apiKey = await apiKeys.get();
  if (!apiKey) return undefined;
  return createClaudeTranslator({ apiKey, fetch: (url, init) => fetch(url, init), sleep, now: () => performance.now() });
}

class NoApiKeyError extends Error {}

async function translate(input: TranslateInput, fake: FakeTranslatorConfig | undefined): Promise<TranslateOutput> {
  // e2e build 才有：FakeTranslator 取代 Claude（正式 build 裡 __E2E__ 是 false，整段與 ground truth 都不會打包）
  if (__E2E__ && fake) return createFakeTranslator(SYNTHETIC_GROUND_TRUTH, fake).translatePage(input);
  const translator = await claude();
  if (!translator) throw new NoApiKeyError('尚未設定 API key');
  return translator.translatePage(input);
}

async function testConnection(): Promise<TestConnectionResponse> {
  try {
    const translator = await claude();
    if (!translator) return { ok: false, error: '尚未設定 API key' };
    return { ok: true, ...(await translator.testConnection()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
  if (message.type === 'offscreen:translate') {
    translate(message.input, message.fake).then(
      (output) => sendResponse({ output } satisfies TranslateResponse),
      (e: unknown) =>
        sendResponse({
          error: e instanceof Error ? e.message : String(e),
          ...(e instanceof NoApiKeyError ? { noApiKey: true as const } : {}),
        } satisfies TranslateResponse),
    );
    return true;
  }
  if (message.type === 'offscreen:testConnection') {
    testConnection().then(sendResponse);
    return true;
  }
  return false;
});
