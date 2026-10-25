import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from './build.ts';

let prodDir: string;
let e2eDir: string;

beforeAll(async () => {
  prodDir = await mkdtemp(join(tmpdir(), 'manga-prod-'));
  e2eDir = await mkdtemp(join(tmpdir(), 'manga-e2e-'));
  await Promise.all([build({ e2e: false, outDir: prodDir }), build({ e2e: true, outDir: e2eDir })]);
}, 30_000);

afterAll(async () => {
  await Promise.all([rm(prodDir, { recursive: true, force: true }), rm(e2eDir, { recursive: true, force: true })]);
});

const readJson = async (dir: string, file: string) => JSON.parse(await readFile(join(dir, file), 'utf8'));
const readText = (dir: string, file: string) => readFile(join(dir, file), 'utf8');
const exists = (dir: string, file: string) => access(join(dir, file)).then(() => true, () => false);

describe('正式 build', () => {
  it('manifest 只含 spec 第 6 節的權限，沒有 host 權限與靜態 content script', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');

    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'sidePanel', 'unlimitedStorage']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.commands).toBeDefined();
  });

  it('產出四種入口：service worker、offscreen、side panel、可動態注入的 content script', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');

    expect(await readText(prodDir, manifest.background.service_worker)).not.toBe('');
    expect(manifest.side_panel.default_path).toBe('sidepanel.html');
    expect(await readText(prodDir, 'sidepanel.html')).toContain('sidepanel.js');
    expect(await readText(prodDir, 'offscreen.html')).toContain('offscreen.js');
    // executeScript({files}) 只能載入傳統 script：不能有 import／export。
    const content = await readText(prodDir, 'content.js');
    expect(content).not.toMatch(/^\s*(import|export)\b/m);
  });

  it('不包含 e2e 測試入口、FakeTranslator 與合成頁 ground truth', async () => {
    const sw = await readText(prodDir, 'background.js');

    expect(sw).not.toContain('test:activate');
    expect(sw).not.toContain('test:configure');
    // 沒 minify 時死分支的程式碼還在（if (false) {...}），但它引用的模組不會被打包進來。
    expect(sw).not.toContain('FakeTranslator：找不到對應的原文');
    expect(sw).not.toContain('早安！今天好早喔');
    expect(await exists(prodDir, 'test-pipeline.html')).toBe(false);
  });

  it('打包 onnxruntime-web 的 wasm 與 kuromoji 字典，但不打包 ONNX 模型（第一次使用時才下載）', async () => {
    expect(await exists(prodDir, 'ort/ort.webgpu.bundle.min.mjs')).toBe(true);
    expect(await exists(prodDir, 'ort/ort-wasm-simd-threaded.asyncify.wasm')).toBe(true);
    expect(await exists(prodDir, 'kuromoji/dict/base.dat.gz')).toBe(true);
    const files = await readdir(prodDir, { recursive: true });
    expect(files.filter((f) => f.endsWith('.onnx'))).toEqual([]);
  });

  it('外掛頁面 cross-origin isolated，onnxruntime-web 的 wasm 才能多執行緒', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');

    expect(manifest.cross_origin_embedder_policy).toEqual({ value: 'require-corp' });
    expect(manifest.cross_origin_opener_policy).toEqual({ value: 'same-origin' });
  });

  it('CSP 只多開放編譯 wasm，不開放 eval 與外部 script', async () => {
    const manifest = await readJson(prodDir, 'manifest.json');

    expect(manifest.content_security_policy).toEqual({ extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" });
  });
});

describe('e2e build', () => {
  it('多宣告 <all_urls>，並包含測試入口', async () => {
    const manifest = await readJson(e2eDir, 'manifest.json');
    const sw = await readText(e2eDir, 'background.js');

    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(sw).toContain('test:activate');
  });

  it('多一個量 #7 指標用的流水線測試頁', async () => {
    expect(await readText(e2eDir, 'test-pipeline.html')).toContain('test-pipeline.js');
  });
});
