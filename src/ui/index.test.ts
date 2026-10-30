import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

/** 外掛專屬的 store：只有外掛的 container（src/sidepanel/main.tsx）能用。 */
const STORE_MODULES = ['src/shared/api-key-store.ts', 'src/shared/data-consent.ts', 'src/shared/db.ts'];

describe('src/ui（外掛與產品網站共用的畫面）', () => {
  it('打包後不含 chrome.*、IndexedDB 與 store 模組，網站可以直接 import', async () => {
    const result = await esbuild.build({
      entryPoints: ['src/ui/index.ts'],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      define: { __E2E__: 'false', __DEBUG__: 'false' },
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    const code = result.outputFiles[0]!.text;

    expect(inputs).toContain('src/ui/side-panel.tsx');
    for (const store of STORE_MODULES) expect(inputs).not.toContain(store);
    // page-mode.ts 的值與型別可以用，但它讀寫 chrome.storage 的函式不能被打包進來
    expect(code).not.toMatch(/\bchrome\./);
    expect(code).not.toContain('indexedDB');
  });
});
