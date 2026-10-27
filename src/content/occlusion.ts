/**
 * 疊在 Page 候選上的元素（#59、ADR 0004）：截圖前暫時藏起來，截完還原。Kindle 的閱讀器把工具列疊在整個 viewport
 * 大小的 img 上面；Jump+ 把透明的翻頁感應區（`<a>`）疊在 canvas 上面。
 * 要碰 DOM（elementsFromPoint、adoptedStyleSheets），單元測試跑在 Node 沒有 DOM，所以由仿 Kindle／Jump+ 的 e2e 測。
 */

/** 取樣格點：橫、直各幾個點（含貼著兩邊的點）。真實 Kindle 一次約 3.4 ms（140 個點）。 */
const SAMPLE_COLUMNS = 14;
const SAMPLE_ROWS = 10;
/** 貼邊的取樣點往內縮這麼多 CSS px，免得取到隔壁元素的邊界。 */
const EDGE_INSET = 2;

/** 可能是漫畫本身（Kindle 左右兩側各有一張預載的頁面 img），不藏。 */
const MEDIA = new Set(['img', 'canvas', 'video']);

/**
 * 取樣期間讓所有元素都接受點擊測試：Kindle 的 img 是 `pointer-events: none`，浮水印、遮罩也常是，
 * elementsFromPoint 會跳過它們，就分不出誰在誰上面。用 adopted stylesheet 而不是改 style 屬性：改屬性會產生
 * mutation，觸發自己的翻頁偵測。同步加上、量完立刻拿掉，瀏覽器沒機會拿它算 hover。
 */
let probeSheet: CSSStyleSheet | undefined;

function withEverythingHitTestable<T>(fn: () => T): T {
  if (!probeSheet) {
    probeSheet = new CSSStyleSheet();
    probeSheet.replaceSync('* { pointer-events: auto !important; }');
  }
  const sheet = probeSheet;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  try {
    return fn();
  } finally {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  }
}

/**
 * hit test 堆疊裡排在任一 anchor 前面、可以藏的元素。不管它有沒有畫東西（透明的感應層藏了也看不出差別）。
 * 不藏：包含 anchor 的祖先、自己的覆蓋層（isOwn，另外照原本方式藏）、img／canvas／video；
 * 包含其他 anchor 的容器不藏本身，往下改藏它的子元素。比取樣間距小的遮擋物可能漏掉（ADR 0004）。
 */
export function findOccluders(anchors: Element[], isOwn: (element: Element) => boolean): Element[] {
  const occluders = new Set<Element>();
  const seen = new Set<Element>();
  const add = (el: Element) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (isOwn(el) || MEDIA.has(el.localName)) return;
    if (anchors.some((a) => el.contains(a))) for (const child of el.children) add(child);
    else occluders.add(el);
  };
  const positions = (start: number, length: number, count: number) =>
    Array.from({ length: count }, (_, i) => start + Math.min(Math.max((length * i) / (count - 1), EDGE_INSET), length - EDGE_INSET));
  withEverythingHitTestable(() => {
    for (const anchor of anchors) {
      const rect = anchor.getBoundingClientRect();
      for (const x of positions(rect.x, rect.width, SAMPLE_COLUMNS)) {
        for (const y of positions(rect.y, rect.height, SAMPLE_ROWS)) {
          const stack = document.elementsFromPoint(x, y);
          const index = stack.indexOf(anchor);
          // anchor 不在這個點的堆疊裡（例如那一點被 iframe 蓋住）：看不出上下，不算
          if (index < 0) continue;
          for (const el of stack.slice(0, index)) if (!el.contains(anchor)) add(el);
        }
      }
    }
  });
  return [...occluders];
}

/**
 * 結構路徑 selector（`:root > body:nth-child(2) > … > a:nth-child(1)`）：選取元素不能加 attribute，
 * 會產生 mutation、觸發自己的翻頁偵測。不在 document 樹上（例如在 shadow root 裡）就是 undefined。
 */
function pathOf(element: Element): string | undefined {
  const parts: string[] = [];
  for (let el = element; el !== document.documentElement; ) {
    const parent = el.parentElement;
    if (!parent) return undefined;
    parts.unshift(`${CSS.escape(el.localName)}:nth-child(${[...parent.children].indexOf(el) + 1})`);
    el = parent;
  }
  return [':root', ...parts].join(' > ');
}

export interface HiddenOccluders {
  /** 藏了幾個元素（0＝不必等重繪）。 */
  count: number;
  /** 拿掉樣式表。回傳 selector 是否還選到同一批元素；不是的話，藏著的期間頁面換了元素，截圖不能用。 */
  restore(): boolean;
}

/** 用 adopted stylesheet 把元素設成透明（`transition: none`：不能等淡出），restore 才拿掉。 */
export function hideOccluders(elements: Element[]): HiddenOccluders {
  const targets = elements.flatMap((element) => {
    const selector = pathOf(element);
    return selector === undefined ? [] : [{ element, selector }];
  });
  if (targets.length === 0) return { count: 0, restore: () => true };
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`${targets.map((t) => t.selector).join(',\n')} { opacity: 0 !important; transition: none !important; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return {
    count: targets.length,
    restore() {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      return targets.every((t) => document.querySelector(t.selector) === t.element);
    },
  };
}

/** trace 用：tag#id.class。 */
export function describe(element: Element): string {
  const cls = typeof element.className === 'string' ? element.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  return `${element.localName}${element.id ? `#${element.id}` : ''}${cls ? `.${cls}` : ''}`;
}
