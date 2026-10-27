/**
 * 原地覆蓋（spec #27 第 7 節、#19 的變體 B）。
 *
 * 每個 anchor 後面插一個 shadow host 當兄弟節點（position:absolute、pointer-events:none），同一個 anchor 上的
 * 多個 Page（Spread 的 subRect）共用一個 host、各自一個 Page 層。Page 層用 Page 原始像素排版，整層
 * translate＋scale 對到 anchor 的 offset*×subRect，捲動、祖先 transform、overflow 裁切都由瀏覽器自然套用。
 * 只在 anchor 尺寸變（ResizeObserver）、視窗大小變、主頁面把 host 丟掉（MutationObserver）時重算或重掛；
 * img 換了 src（Kindle 翻頁）就拿掉上面所有 Page 層，等 SW 送新的。
 * host 是 anchor 的兄弟節點，不會跟著 anchor 被藏起來，所以 anchor 看不到時 host 也自己藏起來。
 *
 * Page Mode（#73）只決定擦字＋譯文那一層要不要顯示：學習時藏起來、保留日文原稿；hover hit-test、tooltip、
 * 高亮框兩種模式都照常運作。
 */
import type { LineRef } from '../shared/messages.ts';
import type { PageMode } from '../shared/page-mode.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import { rubyDisplay } from '../shared/ruby.ts';
import TOKENS from '../shared/tokens.css';
import { createTrace } from '../shared/trace.ts';
import { currentVariant, installSwitcher, limitLine, measure, planPage } from './overlay-layout.prototype.ts';
import { estimatePageFontPx, fitText, isVertical, layerTransform, minLayerFontPx, pageSize, separateRegions, textRegions, verticalize, type Box } from './overlay-layout.ts';

/** 載入譯文要用的字型（等 document.fonts.load 完成），回傳 CSS font-family。 */
export type LoadFont = (text: string) => Promise<string>;

/**
 * 元素看得到（自己與祖先都不是 display:none、visibility 不是 hidden）。輪流用好幾張疊在一起的 img 的閱讀器
 * （真實 Kindle）用 visibility 藏起舊的那張、留在原地：它不是 Page，上面的覆蓋層也要藏起來。
 * opacity:0 不算：淡出結束不會有 mutation，要另外接 transitionend 才知道。
 */
export const isShown = (element: Element) => element.checkVisibility({ visibilityProperty: true });

/** 給 e2e 與頁面辨識用：shadow host 的屬性。 */
export const HOST_ATTRIBUTE = 'data-naruhodo-overlay';

/** tooltip 與高亮框的顏色、字型取自 design tokens（跟 side panel 同一份，#71）；擦字與譯文的顏色跟著原稿算。 */
const STYLE = `${TOKENS}
:host { all: initial; }
.pl { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; }
.er { position: absolute; border-radius: 3px; }
.tx { position: absolute; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
  text-align: center; line-height: 1.15; overflow: hidden; font-weight: 700; overflow-wrap: anywhere; }
.tx.v { writing-mode: vertical-rl; text-orientation: mixed; }
.tx .u { text-combine-upright: all; }
.tx[data-fit="3"] { align-items: flex-start; justify-content: flex-start; }
:host([data-page-mode="learn"]) .er, :host([data-page-mode="learn"]) .tx { visibility: hidden; }
.tip { position: absolute; display: none; box-sizing: border-box; padding: 0.6em 0.8em; border-radius: 0.6em;
  background: var(--naru-tooltip-bg); color: var(--naru-tooltip-ink); font-weight: 500; line-height: 1.4; white-space: pre-wrap;
  font-family: var(--naru-font-sans); z-index: 2; }
.tip.on { display: block; }
.tip-ja { font-family: var(--naru-font-ja); font-size: 1.1em; line-height: 2; color: var(--naru-tooltip-ink-2); }
.tip-ja rt, .tip-guess, .tip-note { color: var(--naru-tooltip-ruby); }
.tip-ja rt { font-weight: 400; }
.tip-guess { font-size: 0.75em; }
.tip-unreadable { color: var(--naru-tooltip-ink-3); text-decoration: line-through dotted; }
.tip-zh { font-size: 1.15em; }
.tip-note { margin-top: 0.3em; font-size: 0.75em; }
.tip.learn .tip-ja { font-size: 1.4em; color: var(--naru-tooltip-ink); }
.tip-reveal { display: flex; align-items: center; gap: 0.6em; box-sizing: border-box; min-height: 3em; margin: 0.3em 0;
  padding: 0.6em 0.75em; border-radius: 0.6em; background: var(--naru-tooltip-chip-bg); border: 1px dashed var(--naru-tooltip-chip-line); }
.tip-reveal.on { background: var(--naru-tooltip-chip-on-bg); border: 1px solid var(--naru-tooltip-chip-on-line); }
.tip-reveal-label { flex: none; display: flex; align-items: center; justify-content: center; width: 1.7em; height: 1.7em;
  border-radius: 0.45em; background: var(--naru-tooltip-ink); color: var(--naru-tooltip-bg); font-weight: 700; }
.tip-reveal-body { color: var(--naru-tooltip-chip-hint); }
.tip-reveal.on .tip-reveal-body { color: var(--naru-on-accent); font-size: 1.15em; }
.hl { position: absolute; display: none; box-sizing: border-box; border-style: solid; border-color: var(--naru-highlight);
  background: var(--naru-highlight-fill); }
.hl.on { display: block; }
`;

const WHOLE_PAGE: RatioRect = { x: 0, y: 0, w: 1, h: 1 };
/** 截圖前等重繪最多這麼久：tab 不在前景時 rAF 不會跑（那時也截不到它）。 */
const FRAME_TIMEOUT_MS = 200;
/** tooltip 的畫面字級。 */
const TOOLTIP_SCREEN_PX = 13;
/** 高亮框的畫面邊框粗細。 */
const HIGHLIGHT_SCREEN_PX = 2;
/**
 * 學習時 tooltip 四周的緩衝（畫面 px）：tooltip 緊貼在句子的框旁邊，滑鼠從句子斜著移進 tooltip 時可能擦過框外一點點。
 * 只在 tooltip 已經顯示時才算，而且只有這麼窄，不會吃掉閱讀網站翻頁感應區的正常使用（spec #70 Further Notes）。
 */
const TOOLTIP_BUFFER_SCREEN_PX = 8;

/** 畫面座標 (x, y) 在 rect 往外擴 margin 的範圍內。 */
const within = (r: DOMRect, x: number, y: number, margin = 0) =>
  x >= r.left - margin && x <= r.right + margin && y >= r.top - margin && y <= r.bottom + margin;

/** 頁面上可以 hover 的一句（Balloon 或 Loose Text），座標是 Page 原始像素。 */
interface HoverLine {
  id: string;
  box: Box;
  原文: string;
  讀音: string;
  譯文: string;
  unreadable: boolean;
}

interface PageLayer {
  /** Page 身分（pageHash），hover 同步用：同一個 anchor 上的兩個 Page 各自一個。 */
  pageHash: string;
  sub: RatioRect;
  size: { width: number; height: number };
  element: HTMLElement;
  tip: HTMLElement;
  /** 高亮框（滑過頁面或 side panel 那行時）。 */
  highlight: HTMLElement;
  lines: HoverLine[];
  /** PROTOTYPE #81：切換排法時用同一份資料重排。 */
  args?: [HTMLElement, RatioRect, PageText, string];
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

function textDiv(className: string, text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  return div;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** 等兩個 rAF（確定已重繪）；tab 在背景時 rAF 不會跑，最多等 FRAME_TIMEOUT_MS。 */
export const untilRepainted = () =>
  Promise.race([nextFrame().then(nextFrame), new Promise<void>((resolve) => setTimeout(resolve, FRAME_TIMEOUT_MS))]);

/** 滑鼠移到哪一句上（null＝離開）。 */
export type OnHover = (line: LineRef | null) => void;

const trace = createTrace('content');

export function createOverlay({ loadFont, onHover }: { loadFont: LoadFont; onHover?: OnHover }) {
  const entries = new Map<HTMLElement, Entry>();
  /** 被我們從 static 改成 relative 的父元素 → 原本的 inline position，停止時還原。 */
  const changedParents = new Map<HTMLElement, string>();
  let pageMode: PageMode = 'read';
  let capturing = false;
  let hiddenAt: number | undefined;
  let stopped = false;

  const resizeObserver = new ResizeObserver((records) => {
    for (const record of records) {
      const entry = entries.get(record.target as HTMLElement);
      if (entry) place(entry);
    }
  });
  const mutationObserver = new MutationObserver((records) => {
    // img 換了 src（Kindle 翻頁、視窗大小變了重新產生合成圖）：上面已經不是那些 Page，舊覆蓋先拿掉，
    // 等 SW 重新擷取後送新的（同一頁就從記住的結果重送，overlay-sync.ts）
    for (const record of records) {
      const entry = record.attributeName === 'src' ? entries.get(record.target as HTMLElement) : undefined;
      if (entry && entry.layers.size > 0) removeLayers(entry, 'anchor 的 src 換了');
    }
    for (const entry of entries.values()) {
      reattach(entry);
      // style／class 變了：anchor（或祖先）可能被藏起來或重新顯示
      applyVisibility(entry);
    }
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class'] });
  const onResize = () => entries.forEach(place);
  window.addEventListener('resize', onResize);
  /** 滑鼠目前在哪一句上（頁面 hover）。 */
  let hovered: { layer: PageLayer; line: HoverLine } | undefined;
  /** side panel 那邊滑過的那句。 */
  let panelHighlight: LineRef | undefined;
  /** 學習時 tooltip 的「譯」區塊是否揭露中（滑鼠在區塊上）。 */
  let revealed = false;
  /** 顯示中的 tooltip 放在句子上方（揭露時長大要留在同一側）。 */
  let tipAbove = false;
  const onPointerMove = (event: PointerEvent) => updateHover(event.clientX, event.clientY);
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  if (__DEBUG__)
    installSwitcher(() => {
      for (const entry of entries.values()) for (const layer of [...entry.layers.values()]) if (layer.args) void show(...layer.args);
    });

  /** host 要不要顯示：不在截圖中、anchor 看得到。 */
  const isVisible = (entry: Entry) => !capturing && isShown(entry.anchor);

  function applyVisibility(entry: Entry): void {
    const visibility = isVisible(entry) ? 'visible' : 'hidden';
    // 只在真的變了才寫：自己的 MutationObserver 也看 style，寫一樣的值會一直被叫回來
    if (entry.host.style.visibility === visibility) return;
    if (!capturing)
      trace('overlay:anchorVisibility', { pageHashes: [...entry.layers.values()].map((layer) => layer.pageHash), shown: visibility === 'visible' });
    entry.host.style.visibility = visibility;
    if (visibility === 'hidden' && hovered && [...entry.layers.values()].includes(hovered.layer)) setHovered(undefined);
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
    const pageHashes = () => [...entry.layers.values()].map((layer) => layer.pageHash);
    if (!entry.anchor.isConnected) {
      if (entry.host.isConnected) {
        entry.host.remove();
        trace('overlay:detach', { pageHashes: pageHashes(), reason: 'anchor 不在 DOM 裡' });
      }
      return;
    }
    if (entry.host.isConnected && entry.host.previousElementSibling === entry.anchor) return;
    trace('overlay:reattach', { pageHashes: pageHashes(), reason: entry.host.isConnected ? 'host 被移到別處' : 'host 被移除' });
    attach(entry);
    place(entry);
  }

  function removeLayers(entry: Entry, reason: string): void {
    trace('overlay:removeLayers', { pageHashes: [...entry.layers.values()].map((layer) => layer.pageHash), reason });
    if (hovered && [...entry.layers.values()].includes(hovered.layer)) setHovered(undefined);
    for (const layer of entry.layers.values()) layer.element.remove();
    entry.layers.clear();
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
    host.dataset.pageMode = pageMode;
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

  /** 把一個 Page 的譯文覆蓋在 anchor 上；同一個 Page（subRect）再呼叫就換成新的。pageHash＝hover 同步用的 Page 身分。 */
  async function show(anchor: HTMLElement, sub: RatioRect = WHOLE_PAGE, text: PageText, pageHash = ''): Promise<void> {
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
    const highlight = document.createElement('div');
    highlight.className = 'hl';
    const toHoverLine = (t: PageText['balloons'][number] | PageText['looseText'][number], bbox: RatioRect): HoverLine => ({
      id: t.id,
      box: toPx(bbox, size),
      原文: t.原文,
      讀音: t.讀音,
      譯文: t.譯文,
      unreadable: t.unreadable,
    });
    // unreadable 與 Loose Text 不覆蓋，但滑過時一樣有 tooltip、一樣跟 side panel 同步
    const lines: HoverLine[] = [
      ...text.balloons.map((b) => toHoverLine(b, b.balloonBbox)),
      ...text.looseText.map((l) => toHoverLine(l, l.bbox)),
    ];
    const layer: PageLayer = { pageHash, sub, size, element, tip, highlight, lines, args: [anchor, sub, text, pageHash] };

    const regionsList = balloons.map((balloon) => {
      const text = toPx(balloon.textBbox, size);
      return { text, ...textRegions(toPx(balloon.balloonBbox, size), text) };
    });
    separateRegions(regionsList);
    const items = balloons.map((balloon, i) => {
      const balloonBox = toPx(balloon.balloonBbox, size);
      const regions = regionsList[i]!;
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
      return { balloon, regions, erase, box, inner, vertical };
    });
    // 擦除底色全部在譯文之前：偵測框重疊時，後一個 Balloon 的底色才不會蓋掉前一個的譯文
    element.append(...items.map((item) => item.erase), ...items.map((item) => item.box), highlight, tip);

    const old = entry.layers.get(subKey(sub));
    if (old && hovered?.layer === old) setHovered(undefined);
    entry.layers.set(subKey(sub), layer);
    entry.root.append(element);
    old?.element.remove();
    place(entry);

    // 縮字只在建立時量一次（實際量測是否溢出）；縮放不重排。最小字級用當下的畫面倍率換算，起始字級跟著原作字級（#80）。
    const screenScale = (anchor.getBoundingClientRect().width * sub.w) / size.width || 1;
    const minLayerPx = minLayerFontPx(screenScale);
    const startPx = estimatePageFontPx(balloons.map((b, i) => ({ text: regionsList[i]!.text, 原文: b.原文 })));
    const plans = __DEBUG__ ? planPage(items.map(({ balloon, regions, vertical }) => ({ text: regions.text, 原文: balloon.原文, 譯文: balloon.譯文, vertical }))) : [];
    const fits: Record<string, unknown>[] = [];
    for (const [i, { balloon, regions, box, inner, vertical }] of items.entries()) {
      const plan = plans[i];
      if (__DEBUG__ && plan?.lines) {
        inner.replaceChildren(...plan.lines.flatMap((line, k) => [...(k ? [document.createElement('br')] : []), ...buildText(line, vertical).childNodes]));
        inner.style.whiteSpace = 'nowrap';
      }
      const result = fitText(
        {
          apply(region, px) {
            setBox(box, __DEBUG__ && plan ? limitLine(region, px, vertical, plan.charsPerLine) : region);
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
        __DEBUG__ && plan ? plan.startPx : startPx,
      );
      box.dataset.fit = String(result.stage);
      if (__DEBUG__)
        fits.push({ id: balloon.id, 譯文: balloon.譯文, vertical, ...result, regions, eraseLuminance: balloon.eraseLuminance, ...plan, ...measure(inner, regions.text, result.size, vertical) });
    }
    if (__DEBUG__) {
      const anchorRect = anchor.getBoundingClientRect();
      trace('overlay:show', {
        pageHash,
        sub,
        pageSize: size,
        anchorRect: { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height },
        screenScale,
        minLayerPx,
        startPx,
        variant: currentVariant(),
        skipped: text.balloons.filter((b) => !balloons.includes(b)).map((b) => ({ id: b.id, unreadable: b.unreadable, 譯文: b.譯文 })),
        fits,
      });
    }
    tip.style.fontSize = `${TOOLTIP_SCREEN_PX / screenScale}px`;
    tip.style.maxWidth = `${size.width * 0.8}px`;
    highlight.style.borderWidth = `${HIGHLIGHT_SCREEN_PX / screenScale}px`;
    highlight.style.borderRadius = `${(2 * HIGHLIGHT_SCREEN_PX) / screenScale}px`;
    renderHighlights();
    // 等畫到畫面上才 resolve：呼叫端接著會截「帶覆蓋層的樣子」，太早截會截到還沒畫出來的畫面
    await untilRepainted();
  }

  /**
   * 覆蓋層一律 pointer-events:none，hover 靠座標自己 hit-test（spec 第 7.1 節）：Page 層的畫面 rect（含捲動與
   * 祖先 transform）換算回 Page 原始像素，找包含滑鼠的最小那句。
   */
  function updateHover(x: number, y: number): void {
    // 學習時滑鼠在顯示中的 tooltip 上（含緩衝）：tooltip 留著，在「譯」區塊上就揭露譯文
    if (hovered && pageMode === 'learn' && within(hovered.layer.tip.getBoundingClientRect(), x, y, TOOLTIP_BUFFER_SCREEN_PX)) {
      const chip = hovered.layer.tip.querySelector('.tip-reveal');
      setRevealed(chip !== null && within(chip.getBoundingClientRect(), x, y));
      return;
    }
    let hit: { layer: PageLayer; line: HoverLine; area: number } | undefined;
    for (const entry of entries.values()) {
      if (entry.host.style.visibility === 'hidden') continue;
      for (const layer of entry.layers.values()) {
        const r = layer.element.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const px = ((x - r.left) / r.width) * layer.size.width;
        const py = ((y - r.top) / r.height) * layer.size.height;
        for (const line of layer.lines) {
          const { box } = line;
          if (px < box.x || px > box.x + box.w || py < box.y || py > box.y + box.h) continue;
          const area = box.w * box.h;
          if (!hit || area < hit.area) hit = { layer, line, area };
        }
      }
    }
    setHovered(hit && { layer: hit.layer, line: hit.line });
  }

  function setHovered(next: { layer: PageLayer; line: HoverLine } | undefined): void {
    if (next?.layer === hovered?.layer && next?.line === hovered?.line) return;
    const previous = hovered;
    hovered = next;
    previous?.layer.tip.classList.remove('on');
    if (next) showTooltip(next.layer, next.line);
    renderHighlights();
    if (next) onHover?.({ pageHash: next.layer.pageHash, lineId: next.line.id });
    else if (previous) onHover?.(null);
  }

  /**
   * tooltip：原文＋ルビ＋譯文（全文，第 3 階截斷的也看得到）＋「讀音為推測」。學習時譯文藏在「譯」區塊後面，
   * 滑進區塊才揭露；每次顯示都重新藏起來。
   */
  function showTooltip(layer: PageLayer, line: HoverLine): void {
    const { tip } = layer;
    revealed = false;
    const ja = document.createElement('div');
    ja.className = 'tip-ja';
    ja.lang = 'ja';
    const parts: Node[] = [ja];
    if (line.unreadable) {
      ja.classList.add('tip-unreadable');
      ja.textContent = line.原文;
      parts.push(textDiv('tip-zh', '無法辨識'));
    } else {
      const display = rubyDisplay(line.原文, line.讀音);
      if ('segments' in display) {
        for (const segment of display.segments) {
          if (segment.rt === undefined) ja.append(segment.text);
          else {
            const ruby = document.createElement('ruby');
            const rt = document.createElement('rt');
            rt.textContent = segment.rt;
            ruby.append(segment.text, rt);
            ja.append(ruby);
          }
        }
      } else {
        // 對不上：原文＋整句讀音
        ja.append(line.原文, textDiv('tip-guess', display.fallback));
      }
      // 譯文：閱讀直接顯示；學習藏在「譯」區塊後面。沒有譯文就兩種都不放
      if (line.譯文) parts.push(pageMode === 'read' ? textDiv('tip-zh', line.譯文) : revealChip(line.譯文));
      if (line.讀音) parts.push(textDiv('tip-note', '讀音為推測'));
    }
    tip.classList.toggle('learn', pageMode === 'learn');
    tip.replaceChildren(...parts);
    tip.classList.add('on');
    placeTooltip(layer, line);
  }

  function revealChip(譯文: string): HTMLElement {
    const chip = document.createElement('div');
    renderRevealChip(chip, 譯文);
    return chip;
  }

  /** 「譯」區塊（RevealChip 深色版）：未揭露時是提示，揭露後換成譯文。 */
  function renderRevealChip(chip: Element, 譯文: string): void {
    chip.className = revealed ? 'tip-reveal on' : 'tip-reveal';
    chip.replaceChildren(textDiv('tip-reveal-label', '譯'), textDiv('tip-reveal-body', revealed ? 譯文 : '滑過這裡看譯文'));
  }

  function setRevealed(next: boolean): void {
    const chip = hovered?.layer.tip.querySelector('.tip-reveal');
    if (!hovered || !chip || next === revealed) return;
    revealed = next;
    renderRevealChip(chip, hovered.line.譯文);
    // 區塊長大時 tooltip 留在同一側：下方的往下長、上方的往上長，水平仍置中，原本的範圍一定還在裡面，滑鼠不會跑出區塊
    placeTooltip(hovered.layer, hovered.line, tipAbove);
  }

  /** 置中在那句的框下方，夾在 Page 內；下方放不下就放上方。above 有給就固定在那一側。 */
  function placeTooltip(layer: PageLayer, line: HoverLine, above?: boolean): void {
    const { tip } = layer;
    const { box } = line;
    const left = box.x + box.w / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(0, Math.min(left, layer.size.width - tip.offsetWidth))}px`;
    const below = box.y + box.h;
    tipAbove = above ?? below + tip.offsetHeight > layer.size.height;
    tip.style.top = `${tipAbove ? Math.max(0, box.y - tip.offsetHeight) : below}px`;
  }

  /** 每個 Page 層最多一個高亮框：頁面 hover 優先，其次是 side panel 滑過的那句。 */
  function renderHighlights(): void {
    for (const entry of entries.values()) {
      for (const layer of entry.layers.values()) {
        const line =
          hovered?.layer === layer
            ? hovered.line
            : panelHighlight?.pageHash === layer.pageHash
              ? layer.lines.find((l) => l.id === panelHighlight!.lineId)
              : undefined;
        layer.highlight.classList.toggle('on', line !== undefined);
        if (line) setBox(layer.highlight, line.box);
      }
    }
  }

  /** side panel 滑過那行 → 頁面上那句高亮；null＝取消。 */
  function highlight(line: LineRef | null): void {
    panelHighlight = line ?? undefined;
    renderHighlights();
  }
  /** Page Mode：學習時藏起擦字＋譯文（用 visibility，藏著時仍能量測排版）；顯示中的 tooltip 換成新模式的內容。 */
  function setPageMode(mode: PageMode): void {
    if (mode === pageMode) return;
    trace('overlay:pageMode', { pageMode: mode });
    pageMode = mode;
    for (const entry of entries.values()) entry.host.dataset.pageMode = mode;
    if (hovered) showTooltip(hovered.layer, hovered.line);
  }

  /** 截圖前：隱藏所有 host（學習時也藏，tooltip 與高亮框不能進截圖），等兩個 rAF（確定已重繪）。 */
  async function hideForCapture(): Promise<void> {
    capturing = true;
    entries.forEach(applyVisibility);
    if (entries.size === 0) return;
    hiddenAt = performance.now();
    await untilRepainted();
  }

  /** 截完立刻還原；回傳覆蓋層被藏了多久（ms），沒藏就是 undefined。 */
  function restoreAfterCapture(): number | undefined {
    capturing = false;
    entries.forEach(applyVisibility);
    const ms = hiddenAt === undefined ? undefined : performance.now() - hiddenAt;
    hiddenAt = undefined;
    return ms;
  }

  /** 這個 anchor 上正顯示著覆蓋層的 Page（pageHash）；學習（頁面上沒蓋任何東西）或 host 不在畫面上就是空的。 */
  function shownPages(anchor: Element): string[] {
    const entry = entries.get(anchor as HTMLElement);
    if (!entry || pageMode === 'learn' || stopped || !entry.host.isConnected) return [];
    return [...entry.layers.values()].map((layer) => layer.pageHash);
  }

  /** 停止：拿掉所有 host、還原被改成 relative 的父元素。 */
  function clear(): void {
    stopped = true;
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener('resize', onResize);
    document.removeEventListener('pointermove', onPointerMove, { capture: true });
    hovered = undefined;
    panelHighlight = undefined;
    for (const entry of entries.values()) entry.host.remove();
    entries.clear();
    for (const [parent, position] of changedParents) parent.style.position = position;
    changedParents.clear();
  }

  /** 這個元素的 style 被我們改過（static → relative）。 */
  function ownsStyleOf(element: Element): boolean {
    return changedParents.has(element as HTMLElement);
  }

  return { show, highlight, setPageMode, hideForCapture, restoreAfterCapture, shownPages, clear, ownsStyleOf };
}

export type Overlay = ReturnType<typeof createOverlay>;
