// e2e build 才有（spec #27 第 12 節第 2 層）：把合成頁的 ground truth 直接畫成覆蓋層，量譯文的 rect（e2e/overlay-render.spec.ts）。
// 跟 content script 用同一個 createOverlay 與字型載入器；這裡是外掛頁面，fetch 字型不需要 web_accessible_resources。
import type { PageMode } from '../shared/page-mode.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import { createOverlay, type Overlay } from '../content/overlay.ts';
import { createOverlayFontLoader } from '../content/overlay-font.ts';

declare global {
  var __renderOverlay: (input: { image: string; width: number; pages: { sub: RatioRect; text: PageText }[]; pageMode?: PageMode }) => Promise<void>;
}

const loadFont = createOverlayFontLoader();
let overlay: Overlay | undefined;

globalThis.__renderOverlay = async ({ image, width, pages, pageMode = 'read' }) => {
  overlay?.clear();
  overlay = createOverlay({ loadFont });
  overlay.setPageMode(pageMode);
  // 父元素是 static：跟仿 Jump+ 一樣會被改成 relative
  const slot = document.createElement('div');
  slot.className = 'slot';
  const img = document.createElement('img');
  img.style.width = `${width}px`;
  img.src = image;
  slot.append(img);
  document.body.replaceChildren(slot);
  await img.decode();
  for (const { sub, text } of pages) await overlay.show(img, sub, text);
};
