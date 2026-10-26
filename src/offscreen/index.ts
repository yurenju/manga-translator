// offscreen document：裁切截圖、Page hash、偵測＋OCR＋閱讀順序、呼叫 LLM（spec #27 第 2 節）。
// 由 SW 在需要時用 chrome.offscreen.createDocument 建立，manifest 不必宣告。
import { SYNTHETIC_GROUND_TRUTH } from '../background/synthetic-ground-truth.ts';
import { ERASE_PADDING } from '../content/overlay-layout.ts';
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
import { createTrace } from '../shared/trace.ts';
import type { TranslateInput, TranslateOutput } from '../shared/translator.ts';
import { createClaudeTranslator } from './claude-translator.ts';
import { thumbnailSize, toImageRect } from './crop.ts';
import { eraseLuminance } from './erase-color.ts';
import { createLocalPipeline } from './local-pipeline.ts';
import { createPageImage } from './page-image.ts';

const trace = createTrace('offscreen');

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
    trace('models', { ...status });
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
    const startedAt = performance.now();
    const text = await pipeline.analyze(bitmap, rect);
    if (__DEBUG__) {
      trace('analyze', {
        anchorId: candidate.anchorId,
        imageRect: rect,
        ms: Math.round(performance.now() - startedAt),
        balloons: text.balloons.map(({ id, order, orientation, 原文, balloonBbox, textBbox }) => ({ id, order, orientation, 原文, balloonBbox, textBbox })),
        looseText: text.looseText.map(({ id, order, orientation, 原文, bbox }) => ({ id, order, orientation, 原文, bbox })),
        detections: await detectionImage(bitmap, rect, text),
      });
    }
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

/**
 * debug build 才用：裁好的 Page 疊上偵測結果（藍＝Balloon 外框、紅＝文字框、綠＝Loose Text，數字是閱讀順序），
 * 對照 OCR 漏字或覆蓋位置。
 */
async function detectionImage(bitmap: ImageBitmap, rect: Rect, text: PageText): Promise<string> {
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const line = Math.max(2, Math.round(rect.width / 400));
  ctx.lineWidth = line;
  ctx.font = `bold ${line * 10}px sans-serif`;
  const stroke = (box: { x: number; y: number; w: number; h: number }, color: string, label?: number) => {
    const [x, y, w, h] = [box.x * rect.width, box.y * rect.height, box.w * rect.width, box.h * rect.height];
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
    if (label === undefined) return;
    ctx.fillStyle = color;
    ctx.fillText(String(label), x + line, y + line * 10);
  };
  for (const b of text.balloons) {
    stroke(b.balloonBbox, '#1e6fff', b.order);
    stroke(b.textBbox, '#ff2d2d');
  }
  for (const l of text.looseText) stroke(l.bbox, '#18b84a', l.order);
  return toDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
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
  trace('translate:request', { input });
  try {
    const output = await translator.translatePage(input);
    trace('translate:response', { output });
    return output;
  } catch (e) {
    trace('translate:error', { error: e });
    throw e;
  }
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
