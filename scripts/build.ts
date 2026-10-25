/**
 * 用法：node scripts/build.ts [--e2e]
 *   正式 build → dist/prod；e2e build → dist/e2e（多 <all_urls> 與測試入口，spec #27 第 12 節）
 *
 * 每個入口各自用 esbuild 打包，因為格式不同：
 *   - background（SW）、sidepanel、offscreen：ES module
 *   - content：IIFE。scripting.executeScript({files}) 只能注入傳統 script，不能有 import。
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { buildManifest } from '../src/manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * 原樣複製進外掛的檔案：[來源（相對 repo 根目錄）, 輸出路徑]。
 * 之後的 onnxruntime-web wasm、kuromoji 字典、Noto Sans TC 字型也加在這裡。
 */
const STATIC_FILES: [string, string][] = [
  ['src/sidepanel/sidepanel.html', 'sidepanel.html'],
  ['src/offscreen/offscreen.html', 'offscreen.html'],
];

export async function build({ e2e, outDir }: { e2e: boolean; outDir: string }): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const common: esbuild.BuildOptions = {
    absWorkingDir: root,
    bundle: true,
    outdir: outDir,
    target: 'chrome116',
    define: { __E2E__: String(e2e) },
    jsx: 'automatic',
    jsxImportSource: 'preact',
    sourcemap: e2e ? 'inline' : false,
    logLevel: 'warning',
  };

  await Promise.all([
    esbuild.build({
      ...common,
      format: 'esm',
      entryPoints: {
        background: 'src/background/index.ts',
        sidepanel: 'src/sidepanel/main.tsx',
        offscreen: 'src/offscreen/index.ts',
      },
    }),
    esbuild.build({ ...common, format: 'iife', entryPoints: { content: 'src/content/index.ts' } }),
    ...STATIC_FILES.map(([from, to]) => copyFile(join(root, from), join(outDir, to))),
    writeFile(join(outDir, 'manifest.json'), JSON.stringify(buildManifest({ e2e }), null, 2)),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e2e = process.argv.includes('--e2e');
  const outDir = join(root, 'dist', e2e ? 'e2e' : 'prod');
  await build({ e2e, outDir });
  console.log(`built ${e2e ? 'e2e' : 'prod'} → ${outDir}`);
}
