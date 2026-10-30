/**
 * 首頁互動展示（#109）的進度：點圖示 → 辨識中 → 翻譯中 → 完成，全部用計時器模擬，不跑 OCR、不連網路。
 * 這裡只算「現在 side panel 與頁面該顯示什麼」，畫面是外掛的 SidePanel 與 createOverlay（Demo.tsx）。
 */
import { CLAUDE_MODEL } from '../../../src/shared/claude-request.ts';
import type { PageView } from '../../../src/shared/messages.ts';
import type { PageText } from '../../../src/shared/page-text.ts';

/** closed＝還沒點外掛圖示。 */
export type DemoPhase = 'closed' | 'recognizing' | 'translating' | 'done';

/** 新帳號的免費額度（spec #86 的 Free Pages）；翻完展示的這頁少一頁。 */
export const FREE_PAGES = 50;

/** 展示這頁的 Page 身分：side panel 與覆蓋層的 hover 同步靠它對上同一頁。 */
export const DEMO_PAGE_HASH = 'demo';

/** 每一步停多久才進下一步；加起來 1～2 秒，讓讀者看得到「翻譯中」又不用等太久。 */
const STEPS: Partial<Record<DemoPhase, { phase: DemoPhase; afterMs: number }>> = {
  recognizing: { phase: 'translating', afterMs: 700 },
  translating: { phase: 'done', afterMs: 900 },
};

export function nextPhase(phase: DemoPhase): { phase: DemoPhase; afterMs: number } | undefined {
  return STEPS[phase];
}

export interface DemoView {
  panelOpen: boolean;
  /** 給 SidePanel 的 pages。 */
  pages: PageView[];
  /** side panel 底部的剩餘免費頁數。 */
  remaining: number;
  /** 頁面上畫覆蓋層（譯文、hover tooltip）。 */
  overlay: boolean;
}

const untranslated = (text: PageText): PageText => ({
  balloons: text.balloons.map((b) => ({ ...b, 譯文: '' })),
  looseText: text.looseText.map((l) => ({ ...l, 譯文: '' })),
});

function transcript(phase: DemoPhase, text: PageText): PageView['transcript'] {
  if (phase === 'recognizing') return { state: 'analyzing' };
  if (phase === 'translating') return { state: 'done', text: untranslated(text), translated: false, translating: true };
  return {
    state: 'done',
    text,
    translated: true,
    // 狀態列的數字是展示用的固定值
    translation: { model: CLAUDE_MODEL, latencyMs: 1600, usage: { inputTokens: 2400, outputTokens: 600, cacheReadTokens: 0, costUsd: 0.0006 }, source: 'translated' },
  };
}

export function demoView(phase: DemoPhase, text: PageText): DemoView {
  if (phase === 'closed') return { panelOpen: false, pages: [], remaining: FREE_PAGES, overlay: false };
  const page: PageView = {
    anchorId: 'demo',
    rect: { x: 0, y: 0, width: 0, height: 0 },
    thumbnail: '',
    pageHash: DEMO_PAGE_HASH,
    transcript: transcript(phase, text),
  };
  const done = phase === 'done';
  return { panelOpen: true, pages: [page], remaining: done ? FREE_PAGES - 1 : FREE_PAGES, overlay: done };
}
