/**
 * 自動測試用的模型快取：放在 repo 外（~/.cache/manga-translator/models/<sha256>），每個 worktree 共用、不 commit。
 * 第一次跑時從 Hugging Face 的固定 revision 下載並驗證 SHA-256；之後 mock site 從這裡提供給外掛（e2e/mock-site/server.ts）。
 * 自動測試預設跑 wasm（spec #27 第 12 節），所以只準備 wasm 那一組（約 128 MB）。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MODEL_SETS, modelUrl, type ModelFile } from '../src/offscreen/models/model-files.ts';

export const MODEL_CACHE_DIR = join(homedir(), '.cache', 'manga-translator', 'models');

export const TEST_MODEL_FILES: ModelFile[] = Object.values(MODEL_SETS.wasm);

export const cachedModelPath = (file: ModelFile) => join(MODEL_CACHE_DIR, file.sha256);

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function ensureModelCache(): Promise<void> {
  await mkdir(MODEL_CACHE_DIR, { recursive: true });
  for (const file of TEST_MODEL_FILES) {
    const path = cachedModelPath(file);
    if (await access(path).then(() => true, () => false)) continue;
    console.log(`下載測試用模型 ${file.repo}/${file.path}（${(file.size / 2 ** 20).toFixed(1)} MB）…`);
    const response = await fetch(modelUrl(file));
    if (!response.ok) throw new Error(`下載 ${file.path} 失敗：HTTP ${response.status}`);
    const tmp = `${path}.download`;
    await writeFile(tmp, Buffer.from(await response.arrayBuffer()));
    const digest = await sha256Of(tmp);
    if (digest !== file.sha256) throw new Error(`${file.path} SHA-256 不符：${digest}`);
    await rename(tmp, path);
  }
}
