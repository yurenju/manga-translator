/**
 * localhost mock site（spec #27 第 12 節）。內容一律是 testdata/synthetic 的合成頁。
 *
 * 開兩個 server：網站與圖片在不同 port＝不同 origin，而且圖片 server 不送 CORS header，
 * 所以把圖片畫進 canvas 後 canvas 會是 tainted，跟 Jump+ 一樣不能從 DOM 讀像素。
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cachedModelPath, TEST_MODEL_FILES } from '../model-cache.ts';
import { jumpPlusPage } from './jumpplus.ts';

const PAGES_DIR = new URL('../../testdata/synthetic/out/', import.meta.url);

export interface MockSite {
  /** 仿 Jump+：每頁一個 tainted canvas。 */
  jumpPlusUrl: string;
  /** 取代 https://huggingface.co 的模型下載來源（e2e 透過 test:configure 告訴外掛）。 */
  modelBaseUrl: string;
  /** 外掛向模型下載來源要過的路徑（判斷有沒有重新下載）。 */
  modelRequests: string[];
  /** 之後送出的這個模型檔最後一個 byte 會被改掉（SHA-256 不符）。path 是 ModelFile.path。 */
  corruptModel(path: string): void;
  /** 之後恢復送正確的內容。 */
  repairModels(): void;
  /** 放圖片的另一個 origin；也可以拿來測「換 origin」。 */
  imageOrigin: string;
  close(): Promise<void>;
}

export async function startMockSite(): Promise<MockSite> {
  const images = createServer(async (req, res) => {
    const name = new URL(req.url ?? '/', 'http://x').pathname.slice(1);
    if (!/^[\w-]+\.png$/.test(name)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(new URL(name, PAGES_DIR));
      res.writeHead(200, { 'content-type': 'image/png' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  const imageOrigin = await listen(images);

  const modelRequests: string[] = [];
  const corrupted = new Set<string>();
  const site = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    // /jumpplus/ 以下的任何路徑都是同一個仿 Jump+（同網站的另一話，#36 網址模式）
    if (path.startsWith('/jumpplus/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(jumpPlusPage(imageOrigin));
      return;
    }
    if (path.startsWith('/hf/')) {
      // 仿 Hugging Face 的 /<repo>/resolve/<revision>/<path>；內容來自 repo 外的模型快取
      const file = TEST_MODEL_FILES.find((f) => path === `/hf/${f.repo}/resolve/${f.revision}/${f.path}`);
      modelRequests.push(path);
      if (!file) {
        res.writeHead(404, { 'access-control-allow-origin': '*' }).end();
        return;
      }
      const body = await readFile(cachedModelPath(file));
      if (corrupted.has(file.path)) body[body.length - 1] = body.at(-1)! ^ 0xff;
      res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  const siteOrigin = await listen(site);

  return {
    jumpPlusUrl: `${siteOrigin}/jumpplus/`,
    modelBaseUrl: `${siteOrigin}/hf`,
    modelRequests,
    corruptModel: (path) => void corrupted.add(path),
    repairModels: () => corrupted.clear(),
    imageOrigin,
    close: async () => {
      await Promise.all([close(site), close(images)]);
    },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
