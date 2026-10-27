/**
 * PROTOTYPE（#81，用完即丟，不進 main）：在真實網站上切換幾種「譯文字級＋斷行」排法，並排比較閱讀體驗。
 * 只在 debug build 掛上（overlay.ts 用 __DEBUG__ 包起來）。頁面底部有切換列；也可用 debug:eval content 呼叫
 * globalThis.__naruVariant('C')。每次切換都重排目前所有 Page，overlay:show 的 trace 帶填充率與行數。
 */
import type { Box } from './overlay-layout.ts';

export type VariantKey = 'E' | 'F' | 'G';

export const VARIANTS: { key: VariantKey; name: string }[] = [
  { key: 'E', name: '每框中文字數 ±25%＋縮框對齊原文行數' },
  { key: 'F', name: 'E 的字級＋詞界斷行（標點優先），行數＝原文' },
  { key: 'G', name: 'F，但行數可在原文 ±1 裡挑' },
];

let current: VariantKey = 'E';
export const currentVariant = () => current;

const START_PX = 26;
const INK_PER_CELL = 0.54;
const INK_PER_EM = 0.9;
const FONT_ESTIMATE_FACTOR = 0.9;
/** 原作字距 ≈ 字寬 × 1.21（#81 量測）。 */
const PITCH_PER_INK = 1.21;
const CLAMP = 0.25;

const cellCount = (text: string) => [...text.replace(/[.・]{2,}|…+/g, '……').replace(/\s/g, '')].length;
const fontFromCell = (cell: number) => (cell * INK_PER_CELL * FONT_ESTIMATE_FACTOR) / INK_PER_EM;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 ? s[Math.floor(mid)]! : (s[mid - 1]! + s[mid]!) / 2;
};

export interface PlanInput {
  text: Box;
  原文: string;
  譯文: string;
  vertical: boolean;
}

export interface Plan {
  startPx: number;
  /** 對齊原文行數時，每行最多幾個字（undefined＝不限制）。 */
  charsPerLine?: number;
  /** 明確斷好的行（F、G）；有它就不縮框、不自動換行。 */
  lines?: string[];
  estOriginalLines: number;
}

/** 依目前的 variant 算每個框的起始字級與每行字數。 */
export function planPage(items: PlanInput[]): Plan[] {
  const valid = (t: Box, n: number) => t.w * t.h > 0 && n > 0;
  const jaCells = items.map(({ text, 原文 }) => (valid(text, cellCount(原文)) ? Math.sqrt((text.w * text.h) / cellCount(原文)) : undefined));
  const zhCells = items.map(({ text, 譯文 }) => (valid(text, cellCount(譯文)) ? Math.sqrt((text.w * text.h) / cellCount(譯文)) : undefined));
  const ok = (xs: (number | undefined)[]) => xs.filter((x): x is number => x !== undefined);
  const pageJa = ok(jaCells).length ? fontFromCell(median(ok(jaCells))) : START_PX;
  const pageZh = ok(zhCells).length ? fontFromCell(median(ok(zhCells))) : START_PX;

  return items.map((item, i) => {
    // 原文行數：一行放幾字＝文字框長邊（直書是高）÷ 原作字距
    const ja = jaCells[i];
    const pitch = ja ? ja * INK_PER_CELL * PITCH_PER_INK : 0;
    const along = item.vertical ? item.text.h : item.text.w;
    const perLine = pitch > 0 ? Math.max(1, Math.floor(along / pitch)) : Infinity;
    const estOriginalLines = Number.isFinite(perLine) ? Math.ceil(cellCount(item.原文) / perLine) : 1;
    const zh = zhCells[i];
    const clamped = zh ? Math.min(Math.max(fontFromCell(zh), pageZh * (1 - CLAMP)), pageZh * (1 + CLAMP)) : pageZh;
    const charsPerLine = Math.ceil(cellCount(item.譯文) / Math.max(1, estOriginalLines));
    switch (current) {
      case 'E':
        return { startPx: clamped, charsPerLine, estOriginalLines };
      case 'F':
        return { startPx: clamped, lines: breakLines(item.譯文, estOriginalLines, [0]), estOriginalLines };
      case 'G':
        return { startPx: clamped, lines: breakLines(item.譯文, estOriginalLines, [-1, 0, 1]), estOriginalLines };
    }
  });
}

const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'word' });
/** 不能放行首（黏到前一段）：標點、刪節號、破折號、右括號。 */
const NO_LINE_START = /^[，。、！？；：…—～）」』》〉,.!?;:~)\]]/;
/** 不能放行尾（黏到下一段）：左括號、數字、「第」（第一層、四個人、B級、10級）。 */
const NO_LINE_END = /[（「『《〈(\[0-9A-Za-z０-９一二三四五六七八九十百千兩幾第]$/;
const PUNCT_END = /[，。、！？；：…—～」』）,.!?;:~]$/;

/** 斷成不可再切的單位：詞界，再套避頭尾與數量詞黏合。 */
export function units(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    if (/^\s+$/.test(segment)) continue;
    const last = out.at(-1);
    if (last !== undefined && (NO_LINE_START.test(segment) || NO_LINE_END.test(last))) out[out.length - 1] = last + segment;
    else out.push(segment);
  }
  return out;
}

/** 斷在這兩個單位之間的代價：標點後斷不算；兩邊都是單字（多半是斷詞器不認得的詞，如 地|城）很貴，一邊是單字小貴。 */
function breakCost(left: string, right: string): number {
  if (PUNCT_END.test(left)) return 0;
  const single = (u: string) => cellCount(u) === 1;
  return 1.5 + (single(left) && single(right) ? 3 : single(left) || single(right) ? 0.75 : 0);
}

/**
 * 把 units 分成連續的幾行：行數＝原文行數＋deltas 之一。成本＝各行長度離平均的平方和＋每個斷點的 breakCost
 * ＋行數偏離原文 × 2，取最小。
 */
export function breakLines(text: string, targetLines: number, deltas: number[]): string[] {
  const us = units(text);
  const lens = us.map(cellCount);
  const total = lens.reduce((a, b) => a + b, 0);
  let best: { cost: number; lines: string[] } | undefined;
  for (const n of deltas.map((d) => targetLines + d).filter((c) => c >= 1 && c <= us.length)) {
    const avg = total / n;
    // dp[k][i]：前 i 個單位分成 k 行的最小成本與上一個斷點
    const dp: { cost: number; prev: number }[][] = Array.from({ length: n + 1 }, () => []);
    dp[0]![0] = { cost: 0, prev: -1 };
    for (let k = 1; k <= n; k++)
      for (let i = k; i <= us.length; i++)
        for (let j = k - 1; j < i; j++) {
          const from = dp[k - 1]![j];
          if (!from) continue;
          const len = lens.slice(j, i).reduce((a, b) => a + b, 0);
          const cost = from.cost + (len - avg) ** 2 + (i < us.length ? breakCost(us[i - 1]!, us[i]!) : 0);
          if (!dp[k]![i] || cost < dp[k]![i]!.cost) dp[k]![i] = { cost, prev: j };
        }
    const lines: string[] = [];
    for (let k = n, i = us.length; k > 0; k--) {
      const j = dp[k]![i]!.prev;
      lines.unshift(us.slice(j, i).join(''));
      i = j;
    }
    const cost = dp[n]![us.length]!.cost + Math.abs(n - targetLines) * 2;
    if (!best || cost < best.cost) best = { cost, lines };
  }
  return best?.lines ?? [text];
}

/** 對齊行數：把範圍沿著行的方向縮到「每行字數 × 字級」，置中；不會比原範圍大。 */
export function limitLine(region: Box, px: number, vertical: boolean, charsPerLine: number | undefined): Box {
  if (!charsPerLine) return region;
  const length = charsPerLine * px + px * 0.3;
  if (vertical) {
    const h = Math.min(region.h, length);
    return { ...region, y: region.y + (region.h - h) / 2, h };
  }
  const w = Math.min(region.w, length);
  return { ...region, x: region.x + (region.w - w) / 2, w };
}

/** 量實際排出來的結果：填充率（譯文墨水框 ÷ 文字框）與行數。 */
export function measure(inner: HTMLElement, text: Box, px: number, vertical: boolean) {
  const across = vertical ? inner.offsetWidth : inner.offsetHeight;
  return {
    fillRate: Math.round(((inner.offsetWidth * inner.offsetHeight) / (text.w * text.h)) * 100) / 100,
    lines: Math.max(1, Math.round(across / (px * 1.15))),
  };
}

/** 頁面底部的切換列（‹ 名稱 ›，快捷鍵 [ ]；Kindle 的方向鍵是翻頁，不攔）。 */
export function installSwitcher(rerender: () => void): void {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:#111;color:#fff;
      font:600 13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);border:2px solid #f5c400}
    button{all:unset;cursor:pointer;padding:2px 10px;border-radius:999px;background:#333}
    button:hover{background:#555} .tag{color:#f5c400}
  </style><div class="bar"><button data-d="-1">‹</button><span class="label"></span><button data-d="1">›</button></div>`;
  const label = root.querySelector('.label')!;
  const render = () => {
    const v = VARIANTS.find((x) => x.key === current)!;
    label.innerHTML = `<span class="tag">PROTOTYPE #81</span> ${v.key}（${v.name}）`;
  };
  const go = (key: VariantKey) => {
    current = key;
    render();
    rerender();
  };
  const step = (d: number) => {
    const i = VARIANTS.findIndex((x) => x.key === current);
    go(VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length]!.key);
  };
  root.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => step(Number(b.dataset.d))));
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
    if (e.key === '[') step(-1);
    if (e.key === ']') step(1);
  });
  (globalThis as unknown as { __naruVariant: (k: VariantKey) => void }).__naruVariant = go;
  render();
  document.documentElement.append(host);
}
