/**
 * 原地覆蓋（spec #27 第 7 節、#19 的變體 B）。
 *
 * 每個 anchor 後面插一個 shadow host 當兄弟節點（position:absolute、pointer-events:none），同一個 anchor 上的
 * 多個 Page（Spread 的 subRect）共用一個 host、各自一個 Page 層。Page 層用 Page 原始像素排版，整層
 * translate＋scale 對到 anchor 的 offset*×subRect，捲動、祖先 transform、overflow 裁切都由瀏覽器自然套用。
 * 只在 anchor 尺寸變（ResizeObserver）、視窗大小變、主頁面把 host 丟掉（MutationObserver）時重算或重掛。
 */
import type { PageText, RatioRect } from '../shared/page-text.ts';
import { fitText, isVertical, layerTransform, minLayerFontPx, pageSize, textRegions, verticalize, type Box } from './overlay-layout.ts';

/** 載入譯文要用的字型（等 document.fonts.load 完成），回傳 CSS font-family。 */
export type LoadFont = (text: string) => Promise<string>;

/** 給 e2e 與頁面辨識用：shadow host 的屬性。 */
export const HOST_ATTRIBUTE = 'data-manga-translator-overlay';

const STYLE = `
:host { all: initial; }
.pl { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; }
.er { position: absolute; border-radius: 3px; }
.tx { position: absolute; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
  text-align: center; line-height: 1.15; overflow: hidden; font-weight: 700; overflow-wrap: anywhere; }
.tx.v { writing-mode: vertical-rl; text-orientation: mixed; }
.tx .u { text-combine-upright: all; }
.tx[data-fit="3"] { align-items: flex-start; justify-content: flex-start; }
.tip { position: absolute; display: none; box-sizing: border-box; padding: 0.4em 0.6em; border-radius: 0.4em;
  background: rgba(20, 20, 20, 0.92); color: #fff; font-weight: 600; line-height: 1.4; white-space: pre-wrap; }
.tip.on { display: block; }
`;

const WHOLE_PAGE: RatioRect = { x: 0, y: 0, w: 1, h: 1 };
/** 截圖前等重繪最多這麼久：tab 不在前景時 rAF 不會跑（那時也截不到它）。 */
const FRAME_TIMEOUT_MS = 200;
/** tooltip 的畫面字級。 */
const TOOLTIP_SCREEN_PX = 13;

interface PageLayer {
  sub: RatioRect;
  size: { width: number; height: number };
  element: HTMLElement;
  tip: HTMLElement;
  /** 第 3 階截斷的譯文元素與它的全文。 */
  truncated: Map<HTMLElement, string>;
}

interface Entry {
  anchor: HTMLElement;
  host: HTMLElement;
  root: ShadowRoot;
  layers: Map<string, PageLayer>;
}

const subKey = (sub: RatioRect) => `${sub.x},${sub.y},${sub.w},${sub.h}`;

/** canvas 的 width/height、img 的 naturalWidth/Height；其他元素不知道。 */
function intrinsicSize(anchor: HTMLElement): { width: number; height: number } {
  if (anchor instanceof HTMLCanvasElement) return { width: anchor.width, height: anchor.height };
  if (anchor instanceof HTMLImageElement) return { width: anchor.naturalWidth, height: anchor.naturalHeight };
  return { width: 0, height: 0 };
}

const toPx = (r: RatioRect, size: { width: number; height: number }): Box => ({
  x: r.x * size.width,
  y: r.y * size.height,
  w: r.w * size.width,
  h: r.h * size.height,
});

function setBox(el: HTMLElement, box: Box): void {
  Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export function createOverlay({ loadFont }: { loadFont: LoadFont }) {
  const entries = new Map<HTMLElement, Entry>();
  /** 被我們從 static 改成 relative 的父元素 → 原本的 inline position，停止時還原。 */
  const changedParents = new Map<HTMLElement, string>();
  let enabled = true;
  let capturing = false;
  let hiddenAt: number | undefined;
  let stopped = false;

  const resizeObserver = new ResizeObserver((records) => {
    for (const record of records) {
      const entry = entries.get(record.target as HTMLElement);
      if (entry) place(entry);
    }
  });
  const mutationObserver = new MutationObserver(() => {
    for (const entry of entries.values()) reattach(entry);
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  const onResize = () => entries.forEach(place);
  window.addEventListener('resize', onResize);
  let pointerFrame = 0;
  let pointer = { x: 0, y: 0 };
  const onPointerMove = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
    if (!pointerFrame) pointerFrame = requestAnimationFrame(updateTooltips);
  };
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });

  function applyVisibility(entry: Entry): void {
    entry.host.style.visibility = enabled && !capturing ? 'visible' : 'hidden';
  }

  /** host 插回 anchor 後面；父元素是 static 就改成 relative（唯一碰主頁面樣式的地方）。 */
  function attach(entry: Entry): void {
    entry.anchor.after(entry.host);
    const parent = entry.host.parentElement;
    if (parent && !changedParents.has(parent) && getComputedStyle(parent).position === 'static') {
      changedParents.set(parent, parent.style.position);
      parent.style.position = 'relative';
    }
    // 跟 anchor 疊在同一層之上
    const z = parseInt(getComputedStyle(entry.anchor).zIndex, 10);
    entry.host.style.zIndex = String(Number.isNaN(z) ? 1 : z + 1);
  }

  /** 主頁面重繪把 host 丟掉（或把 anchor 搬走）就重掛；anchor 不在了就先拿掉 host，等它回來。 */
  function reattach(entry: Entry): void {
    if (!entry.anchor.isConnected) {
      if (entry.host.isConnected) entry.host.remove();
      return;
    }
    if (entry.host.isConnected && entry.host.previousElementSibling === entry.anchor) return;
    attach(entry);
    place(entry);
  }

  function place(entry: Entry): void {
    for (const layer of entry.layers.values()) {
      const t = layerTransform(entry.anchor, layer.sub, layer.size);
      layer.element.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scaleX}, ${t.scaleY})`;
    }
  }

  function entryFor(anchor: HTMLElement): Entry {
    let entry = entries.get(anchor);
    if (entry) return entry;
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, '');
    host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;margin:0;padding:0;border:0;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.append(style);
    entry = { anchor, host, root, layers: new Map() };
    entries.set(anchor, entry);
    applyVisibility(entry);
    attach(entry);
    resizeObserver.observe(anchor);
    return entry;
  }

  function buildText(text: string, vertical: boolean): HTMLElement {
    const inner = document.createElement('span');
    for (const run of vertical ? verticalize(text) : [{ text, upright: false }]) {
      if (!run.upright) inner.append(run.text);
      else {
        const span = document.createElement('span');
        span.className = 'u';
        span.textContent = run.text;
        inner.append(span);
      }
    }
    return inner;
  }

  /** 把一個 Page 的譯文覆蓋在 anchor 上；同一個 Page（subRect）再呼叫就換成新的。 */
  async function show(anchor: HTMLElement, sub: RatioRect = WHOLE_PAGE, text: PageText): Promise<void> {
    // unreadable 與 Loose Text 不覆蓋（spec 第 7.2 節）
    const balloons = text.balloons.filter((b) => !b.unreadable && b.譯文 !== '');
    const fontFamily = await loadFont(balloons.map((b) => b.譯文).join(''));
    if (stopped) return;
    const entry = entryFor(anchor);
    const size = pageSize(intrinsicSize(anchor), sub, anchor);
    const element = document.createElement('div');
    element.className = 'pl';
    Object.assign(element.style, { width: `${size.width}px`, height: `${size.height}px` });
    const tip = document.createElement('div');
    tip.className = 'tip';
    const layer: PageLayer = { sub, size, element, tip, truncated: new Map() };

    const items = balloons.map((balloon) => {
      const balloonBox = toPx(balloon.balloonBbox, size);
      const regions = textRegions(balloonBox, toPx(balloon.textBbox, size));
      const luminance = balloon.eraseLuminance ?? 255;
      const erase = document.createElement('div');
      erase.className = 'er';
      setBox(erase, regions.erase);
      erase.style.background = `rgb(${luminance}, ${luminance}, ${luminance})`;
      const vertical = isVertical(balloon.orientation, balloonBox);
      const box = document.createElement('div');
      box.className = vertical ? 'tx v' : 'tx';
      box.dataset.balloonId = balloon.id;
      box.style.fontFamily = fontFamily;
      box.style.color = luminance < 128 ? '#fff' : '#111';
      const inner = buildText(balloon.譯文, vertical);
      box.append(inner);
      element.append(erase, box);
      return { balloon, regions, box, inner };
    });
    element.append(tip);

    const old = entry.layers.get(subKey(sub));
    entry.layers.set(subKey(sub), layer);
    entry.root.append(element);
    old?.element.remove();
    place(entry);

    // 縮字只在建立時量一次（實際量測是否溢出）；縮放不重排。最小字級用當下的畫面倍率換算。
    const screenScale = (anchor.getBoundingClientRect().width * sub.w) / size.width || 1;
    const minLayerPx = minLayerFontPx(screenScale);
    for (const { balloon, regions, box, inner } of items) {
      const result = fitText(
        {
          apply(region, px) {
            setBox(box, region);
            box.style.fontSize = `${px}px`;
          },
          overflows: () =>
            inner.offsetWidth > box.clientWidth + 1 ||
            inner.offsetHeight > box.clientHeight + 1 ||
            box.scrollWidth > box.clientWidth + 1 ||
            box.scrollHeight > box.clientHeight + 1,
        },
        regions,
        minLayerPx,
      );
      box.dataset.fit = String(result.stage);
      if (result.truncated) layer.truncated.set(box, balloon.譯文);
    }
    tip.style.fontSize = `${TOOLTIP_SCREEN_PX / screenScale}px`;
    tip.style.maxWidth = `${size.width * 0.8}px`;
  }

  /** 覆蓋層一律 pointer-events:none，tooltip 靠座標自己 hit-test（spec 第 7.1 節）。 */
  function updateTooltips(): void {
    pointerFrame = 0;
    for (const entry of entries.values()) {
      for (const layer of entry.layers.values()) {
        let hit: [HTMLElement, string] | undefined;
        for (const [box, full] of layer.truncated) {
          const r = box.getBoundingClientRect();
          if (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom) hit = [box, full];
        }
        if (!hit) {
          layer.tip.classList.remove('on');
          continue;
        }
        const [box, full] = hit;
        const tip = layer.tip;
        tip.textContent = full;
        tip.classList.add('on');
        // 置中在譯文框下方，夾在 Page 內；下方放不下就放上方
        const left = box.offsetLeft + box.offsetWidth / 2 - tip.offsetWidth / 2;
        tip.style.left = `${Math.max(0, Math.min(left, layer.size.width - tip.offsetWidth))}px`;
        const below = box.offsetTop + box.offsetHeight;
        tip.style.top = `${below + tip.offsetHeight <= layer.size.height ? below : Math.max(0, box.offsetTop - tip.offsetHeight)}px`;
      }
    }
  }

  /** side panel 的覆蓋開關。用 visibility，關著時仍能量測排版。 */
  function setEnabled(value: boolean): void {
    enabled = value;
    entries.forEach(applyVisibility);
  }

  /** 截圖前：隱藏所有 host，等兩個 rAF（確定已重繪）。 */
  async function hideForCapture(): Promise<void> {
    capturing = true;
    entries.forEach(applyVisibility);
    if (!enabled || entries.size === 0) return;
    hiddenAt = performance.now();
    await Promise.race([nextFrame().then(nextFrame), new Promise((resolve) => setTimeout(resolve, FRAME_TIMEOUT_MS))]);
  }

  /** 截完立刻還原；回傳覆蓋層被藏了多久（ms），沒藏就是 undefined。 */
  function restoreAfterCapture(): number | undefined {
    capturing = false;
    entries.forEach(applyVisibility);
    const ms = hiddenAt === undefined ? undefined : performance.now() - hiddenAt;
    hiddenAt = undefined;
    return ms;
  }

  /** 停止：拿掉所有 host、還原被改成 relative 的父元素。 */
  function clear(): void {
    stopped = true;
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener('resize', onResize);
    document.removeEventListener('pointermove', onPointerMove, { capture: true });
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    for (const entry of entries.values()) entry.host.remove();
    entries.clear();
    for (const [parent, position] of changedParents) parent.style.position = position;
    changedParents.clear();
  }

  /** 這個元素的 style 被我們改過（static → relative）。 */
  function ownsStyleOf(element: Element): boolean {
    return changedParents.has(element as HTMLElement);
  }

  return { show, setEnabled, hideForCapture, restoreAfterCapture, clear, ownsStyleOf };
}

export type Overlay = ReturnType<typeof createOverlay>;
