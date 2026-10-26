/**
 * 模型檔的下載與快取（spec #27 第 3.3 節）：存在外掛 origin 的 Cache Storage，之後離線可用。
 * 下載完先驗證 SHA-256 才存進快取；不符就丟掉並回報錯誤，下次重新下載。
 */
import { HUGGING_FACE, modelUrl, type ModelFile } from './model-files.ts';

/** Cache Storage 裡放模型的 cache 名稱。 */
export const MODEL_CACHE = 'models-v1';

/** Cache 介面裡用得到的部分（測試可以換成記憶體版）。 */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

export interface DownloadProgress {
  loaded: number;
  /** 這次需要下載的總 bytes（已在快取裡的不算）。 */
  total: number;
}

export interface ModelStoreDeps {
  fetch(url: string): Promise<Response>;
  openCache(): Promise<CacheLike>;
  /** 下載來源；預設 Hugging Face。快取的 key 一律是 Hugging Face 的網址，換來源也命中同一份。 */
  baseUrl?: string;
}

export class ModelIntegrityError extends Error {}

export function createModelStore(deps: ModelStoreDeps) {
  async function download(file: ModelFile, onBytes: (n: number) => void): Promise<ArrayBuffer> {
    const url = modelUrl(file, deps.baseUrl ?? HUGGING_FACE);
    const response = await deps.fetch(url);
    if (!response.ok) throw new Error(`模型下載失敗：${file.path}（HTTP ${response.status}）`);
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      onBytes(value.byteLength);
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = toHex(await crypto.subtle.digest('SHA-256', buffer));
    if (digest !== file.sha256) {
      throw new ModelIntegrityError(`模型檔 SHA-256 不符，已捨棄：${file.path}（預期 ${file.sha256}，實際 ${digest}）`);
    }
    return buffer.buffer;
  }

  /** 依序取得每個檔案的內容；不在快取裡的才下載。 */
  async function load(files: readonly ModelFile[], onProgress?: (progress: DownloadProgress) => void): Promise<ArrayBuffer[]> {
    const cache = await deps.openCache();
    const cached = await Promise.all(files.map((file) => cache.match(modelUrl(file))));
    const total = files.reduce((sum, file, i) => (cached[i] ? sum : sum + file.size), 0);
    let loaded = 0;
    if (total > 0) onProgress?.({ loaded, total });
    const buffers: ArrayBuffer[] = [];
    for (const [i, file] of files.entries()) {
      const hit = cached[i];
      if (hit) {
        buffers.push(await hit.arrayBuffer());
        continue;
      }
      const buffer = await download(file, (n) => {
        loaded += n;
        onProgress?.({ loaded, total });
      });
      await cache.put(modelUrl(file), new Response(buffer.slice(0)));
      buffers.push(buffer);
    }
    return buffers;
  }

  return { load };
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
