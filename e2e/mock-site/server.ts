/**
 * localhost mock site（spec #27 第 12 節）。內容一律是 testdata/synthetic 的合成頁。
 *
 * 開兩個 server：網站與圖片在不同 port＝不同 origin，而且圖片 server 不送 CORS header，
 * 所以把圖片畫進 canvas 後 canvas 會是 tainted，跟 Jump+ 一樣不能從 DOM 讀像素。
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jumpPlusPage } from './jumpplus.ts';

const PAGES_DIR = new URL('../../testdata/synthetic/out/', import.meta.url);

export interface MockSite {
  /** 仿 Jump+：每頁一個 tainted canvas。 */
  jumpPlusUrl: string;
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

  const site = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/jumpplus/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(jumpPlusPage(imageOrigin));
      return;
    }
    res.writeHead(404).end();
  });
  const siteOrigin = await listen(site);

  return {
    jumpPlusUrl: `${siteOrigin}/jumpplus/`,
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
