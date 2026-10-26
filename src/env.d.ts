/** build 時由 esbuild 的 define 換成 true／false；false 時測試入口整段被移除。 */
declare const __E2E__: boolean;
/** debug build（scripts/debug-chrome.ts）才是 true：印除錯記錄（src/shared/debug-trace.ts）。 */
declare const __DEBUG__: boolean;

/** esbuild 用 text loader 把 .css 打包成字串（覆蓋層字型的 unicode-range，src/content/overlay-font.ts）。 */
declare module '*.css' {
  const text: string;
  export default text;
}
