/**
 * 一個 Page 上的文字：Balloon 與 Loose Text（spec #27 第 4.3 節的 balloons／looseText）。
 * 本機流水線（偵測＋OCR＋閱讀順序）產生座標、原文、順序；讀音與譯文來自 Translator，沒有時用 kuromoji 讀音。
 */

/**
 * 相對 Page 的 0～1 比例座標（ADR 0003）。跟 shared/messages.ts 的 Rect（畫面 CSS px）是不同東西，
 * 所以另外取名，也用 w／h 而不是 width／height。
 */
export interface RatioRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Orientation = 'vertical' | 'horizontal';

export interface BalloonText {
  id: string;
  /** 閱讀順序（本機決定），Balloon 與 Loose Text 共用同一串編號，從 1 開始。 */
  order: number;
  /** Balloon 外框（長字排版第 2 階段用）。沒有偵測到外框的 Balloon 等於 textBbox。 */
  balloonBbox: RatioRect;
  /** 文字框（擦除與排版用）。 */
  textBbox: RatioRect;
  orientation: Orientation;
  原文: string;
  讀音: string;
  讀音來源: 'llm' | 'kuromoji';
  /** 空字串＝未翻譯（沒有 API key 或還沒翻）。 */
  譯文: string;
  unreadable: boolean;
}

export interface LooseText {
  id: string;
  order: number;
  bbox: RatioRect;
  orientation: Orientation;
  原文: string;
  讀音: string;
  讀音來源: 'llm' | 'kuromoji';
  譯文: string;
  unreadable: boolean;
}

export interface PageText {
  balloons: BalloonText[];
  looseText: LooseText[];
}

/**
 * 翻譯快取的一筆（spec #27 第 4.3 節）：key＝(seriesId, pageHash)。只存文字與座標，不存頁面圖片；
 * anchor 與 subRect 是畫面狀態，不進快取。
 */
export interface PageTranslation extends PageText {
  seriesId: string;
  /** shared/page-hash.ts 的 perceptual hash；查詢用 Hamming 距離門檻。 */
  pageHash: string;
  /** 判斷過時用（#38）。 */
  usedNotes: { 原文: string; 譯文: string }[];
  model: string;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  latencyMs: number;
  translatedAt: number;
}
