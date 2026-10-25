import { ensureModelCache } from './model-cache.ts';

/** 跑 e2e 前先備好模型（第一次約 128 MB，之後直接用 repo 外的快取）。 */
export default async function globalSetup(): Promise<void> {
  await ensureModelCache();
}
