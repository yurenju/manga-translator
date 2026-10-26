/**
 * Page 候選有沒有被其他元素蓋住（#55、ADR 0004）：Kindle 的閱讀器把工具列疊在整個 viewport 大小的 img 上面。
 * 要碰 DOM（elementsFromPoint、getComputedStyle），單元測試跑在 Node 沒有 DOM，所以由仿 Kindle 的 e2e 測。
 */

/** 取樣格點：橫、直各幾個點（含貼著兩邊的點）。真實 Kindle 一次約 3.4 ms（140 個點）。 */
const SAMPLE_COLUMNS = 14;
const SAMPLE_ROWS = 10;
/** 貼邊的取樣點往內縮這麼多 CSS px，免得取到隔壁元素的邊界。 */
const EDGE_INSET = 2;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 取樣期間讓 img／canvas 接受點擊測試：Kindle 的 img 是 `pointer-events: none`，elementsFromPoint 永遠碰不到它，
 * 就分不出誰在它上面。用 adopted stylesheet 而不是改 style 屬性：改屬性會產生 mutation，觸發自己的翻頁偵測。
 */
let probeSheet: CSSStyleSheet | undefined;

function withHitTestableMedia<T>(fn: () => T): T {
  if (!probeSheet) {
    probeSheet = new CSSStyleSheet();
    probeSheet.replaceSync('img, canvas { pointer-events: auto !important; }');
  }
  const before = [...document.adoptedStyleSheets];
  document.adoptedStyleSheets = [...before, probeSheet];
  try {
    return fn();
  } finally {
    document.adoptedStyleSheets = before;
  }
}

/** 背景色完全透明（computed style 一律是 rgb()／rgba()）。 */
const TRANSPARENT = /^rgba\(.*,\s*0\)$|^transparent$/;

/** 元素在畫面上有畫東西：透明的感應層（Kindle 用蓋滿畫面的透明 div 接點擊）不算遮擋。 */
function paints(element: Element): boolean {
  for (let el: Element | null = element; el; el = el.parentElement) if (getComputedStyle(el).opacity === '0') return false;
  const style = getComputedStyle(element);
  if (style.visibility !== 'visible') return false;
  if (!TRANSPARENT.test(style.backgroundColor) || style.backgroundImage !== 'none') return true;
  if (element.namespaceURI === SVG_NS || /^(IMG|CANVAS|VIDEO|IFRAME)$/.test(element.tagName)) return true;
  for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  return false;
}

/**
 * 蓋在 anchor 上、有畫東西的元素（沒被蓋住時是空陣列）。rect 是 anchor 的 getBoundingClientRect()。
 * isOwn：自己的覆蓋層，不算。比取樣間距小的遮擋物可能漏掉（ADR 0004）。
 */
export function occludersOf(anchor: Element, rect: DOMRectReadOnly, isOwn: (element: Element) => boolean): Element[] {
  const occluders = new Set<Element>();
  const positions = (start: number, length: number, count: number) =>
    Array.from({ length: count }, (_, i) => start + Math.min(Math.max((length * i) / (count - 1), EDGE_INSET), length - EDGE_INSET));
  withHitTestableMedia(() => {
    for (const x of positions(rect.x, rect.width, SAMPLE_COLUMNS)) {
      for (const y of positions(rect.y, rect.height, SAMPLE_ROWS)) {
        const stack = document.elementsFromPoint(x, y);
        const index = stack.indexOf(anchor);
        // anchor 不在這個點的堆疊裡（例如那一點被 iframe 蓋住）：看不出上下，不算
        if (index < 0) continue;
        for (const el of stack.slice(0, index)) if (!occluders.has(el) && !el.contains(anchor) && !isOwn(el) && paints(el)) occluders.add(el);
      }
    }
  });
  return [...occluders];
}
