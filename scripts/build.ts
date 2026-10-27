/**
 * 用法：node scripts/build.ts [--e2e | --debug]
 *   正式 build → dist/prod；e2e build → dist/e2e（多 <all_urls> 與測試入口，spec #27 第 12 節）；
 *   debug build → dist/debug（多印除錯記錄，src/shared/trace.ts；平常由 scripts/debug-chrome.ts 建到固定位置）
 *
 * 每個入口各自用 esbuild 打包，因為格式不同：
 *   - background（SW）、sidepanel、offscreen：ES module
 *   - content：IIFE。scripting.executeScript({files}) 只能注入傳統 script，不能有 import。
 */
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { buildManifest } from '../src/manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * 原樣複製進外掛的檔案：[來源（相對 repo 根目錄）, 輸出路徑]。
 * ONNX 模型不在這裡：第一次使用時才下載（spec #27 第 3.3 節）。Noto Sans TC 字型見 FONT_DIR。
 */
const STATIC_FILES: [string, string][] = [
  ['src/sidepanel/sidepanel.html', 'sidepanel.html'],
  ['src/offscreen/offscreen.html', 'offscreen.html'],
  // onnxruntime-web 不打包進 offscreen.js，執行時動態 import（見 src/offscreen/ort-engine.ts）。
  // webgpu bundle 同時支援 WebGPU 與 wasm，只會載入 asyncify 這一份 wasm（與它的 .mjs，多執行緒 worker 用）。
  ['node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs', 'ort/ort.webgpu.bundle.min.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'ort/ort-wasm-simd-threaded.asyncify.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort/ort-wasm-simd-threaded.asyncify.wasm'],
];

/** 原樣複製的目錄。icons：外掛 icon 的 PNG 與 side panel 標題用的 SVG 母檔（PNG 由 scripts/icons.ts 產出）。 */
const STATIC_DIRS: [string, string][] = [
  ['node_modules/kuromoji/dict', 'kuromoji/dict'],
  ['src/icons', 'icons'],
];

/**
 * 覆蓋層的 Noto Sans TC（#32）：@fontsource 依 unicode-range 切好的 700 字重 woff2 子集（約 3.5 MB），
 * 原樣複製到 fonts/；子集與範圍的對照在 700.css，由 content script 打包成字串（src/content/overlay-font.ts）。
 */
const FONT_DIR = 'node_modules/@fontsource/noto-sans-tc';

/** 700.css 引用的 woff2（同一個目錄還有沒被引用的合併檔，不打包）。 */
export async function overlayFontFiles(): Promise<string[]> {
  const css = await readFile(join(root, FONT_DIR, '700.css'), 'utf8');
  return [...new Set([...css.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)].map((m) => m[1]!))];
}

/** e2e build 才有：量 #7 指標用的流水線測試頁（e2e/ocr-accuracy.spec.ts）、覆蓋渲染測試頁（e2e/overlay-render.spec.ts）。 */
const E2E_STATIC_FILES: [string, string][] = [
  ['src/test-pipeline/test-pipeline.html', 'test-pipeline.html'],
  ['src/test-overlay/test-overlay.html', 'test-overlay.html'],
];

async function copyFonts(outDir: string): Promise<void> {
  await mkdir(join(outDir, 'fonts'), { recursive: true });
  const files = await overlayFontFiles();
  await Promise.all([
    ...files.map((f) => copyFile(join(root, FONT_DIR, 'files', f), join(outDir, 'fonts', f))),
    copyFile(join(root, FONT_DIR, 'LICENSE'), join(outDir, 'fonts', 'LICENSE')),
  ]);
}

export async function build({ e2e, debug = false, outDir }: { e2e: boolean; debug?: boolean; outDir: string }): Promise<void> {
  // 只清空內容、不刪資料夾本身：debug Chrome 載入的就是這個資料夾，整個刪掉再建，
  // 重新載入時 Chrome 曾回報「File path cannot be resolved」並卡在停用（#27 除錯）
  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) await rm(join(outDir, name), { recursive: true, force: true });

  const common: esbuild.BuildOptions = {
    absWorkingDir: root,
    bundle: true,
    outdir: outDir,
    target: 'chrome116',
    define: { __E2E__: String(e2e), __DEBUG__: String(debug) },
    jsx: 'automatic',
    jsxImportSource: 'preact',
    sourcemap: e2e || debug ? 'inline' : false,
    // kuromoji 用 Node 的 path.join 拼字典網址
    alias: { path: './src/offscreen/path-shim.ts' },
    loader: { '.css': 'text' },
    logLevel: 'warning',
  };

  const files = [...STATIC_FILES, ...(e2e ? E2E_STATIC_FILES : [])];
  await Promise.all([
    esbuild.build({
      ...common,
      format: 'esm',
      entryPoints: {
        background: 'src/background/index.ts',
        sidepanel: 'src/sidepanel/main.tsx',
        offscreen: 'src/offscreen/index.ts',
        ...(e2e ? { 'test-pipeline': 'src/test-pipeline/main.ts', 'test-overlay': 'src/test-overlay/main.ts' } : {}),
      },
    }),
    esbuild.build({ ...common, format: 'iife', entryPoints: { content: 'src/content/index.ts' } }),
    ...files.map(async ([from, to]) => {
      await mkdir(dirname(join(outDir, to)), { recursive: true });
      await copyFile(join(root, from), join(outDir, to));
    }),
    copyFonts(outDir),
    ...STATIC_DIRS.map(([from, to]) => cp(join(root, from), join(outDir, to), { recursive: true })),
    writeFile(join(outDir, 'manifest.json'), JSON.stringify(buildManifest({ e2e, debug }), null, 2)),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e2e = process.argv.includes('--e2e');
  const debug = process.argv.includes('--debug');
  const flavor = e2e ? 'e2e' : debug ? 'debug' : 'prod';
  const outDir = join(root, 'dist', flavor);
  await build({ e2e, debug, outDir });
  console.log(`built ${flavor} → ${outDir}`);
}
