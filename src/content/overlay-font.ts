/**
 * 覆蓋層字型的載入（spec #27 第 7.3 節）：打包進外掛的 Noto Sans TC 700，只載入譯文用得到的子集。
 * 自己 fetch 成 ArrayBuffer 再交給 FontFace，不靠 CSS url()：字型檔不受頁面 CSP 的 font-src 限制。
 * content script 在網頁 origin 下 fetch 外掛檔案，所以 fonts/ 要列在 manifest 的 web_accessible_resources。
 */
import css from '@fontsource/noto-sans-tc/700.css';
import { facesFor, parseFontFaces } from './fonts.ts';
import type { LoadFont } from './overlay.ts';

/** 用自己的名字，不跟頁面上可能已經有的 Noto Sans TC 混在一起。 */
export const OVERLAY_FONT_FAMILY = 'Manga Translator Noto Sans TC';

export function createOverlayFontLoader(): LoadFont {
  const faces = parseFontFaces(css);
  const loaded = new Map<string, Promise<void>>();

  async function addFace(file: string, unicodeRange: string): Promise<void> {
    const response = await fetch(chrome.runtime.getURL(`fonts/${file}`));
    if (!response.ok) throw new Error(`font ${file}: HTTP ${response.status}`);
    const face = new FontFace(OVERLAY_FONT_FAMILY, await response.arrayBuffer(), { weight: '700', unicodeRange });
    await face.load();
    document.fonts.add(face);
  }

  return async (text) => {
    try {
      await Promise.all(
        facesFor(text, faces).map((face) => {
          let promise = loaded.get(face.file);
          if (!promise) {
            promise = addFace(face.file, face.unicodeRange);
            loaded.set(face.file, promise);
            // 失敗的下次再試
            promise.catch(() => loaded.delete(face.file));
          }
          return promise;
        }),
      );
      // 量測前確定字型已經可以用
      await document.fonts.load(`700 26px "${OVERLAY_FONT_FAMILY}"`, text);
    } catch (e) {
      console.warn('overlay font failed, falling back to sans-serif', e);
    }
    return `"${OVERLAY_FONT_FAMILY}", sans-serif`;
  };
}
