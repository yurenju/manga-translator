import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

  it('不包含 e2e 測試入口', async () => {
    const sw = await readText(prodDir, 'background.js');

    expect(sw).not.toContain('test:activate');
  });
});

describe('e2e build', () => {
  it('多宣告 <all_urls>，並包含測試入口', async () => {
    const manifest = await readJson(e2eDir, 'manifest.json');
    const sw = await readText(e2eDir, 'background.js');

    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(sw).toContain('test:activate');
  });
});
