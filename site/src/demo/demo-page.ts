/**
 * 展示用的漫畫頁：README 截圖用的那張合成頁（testdata/synthetic，原創、沒有版權問題）。
 * 辨識結果與譯文事先錄好（demo-page.json，取自合成頁的 ground truth），展示時不跑 OCR、不呼叫翻譯。
 * 合成頁改了就重新產生：node scripts/site-demo-page.ts
 */
import type { PageText, RatioRect } from '../../../src/shared/page-text.ts';
import recorded from './demo-page.json' with { type: 'json' };

export const DEMO_PAGE_ID = 'p01-basic';

export const demoPage: { sub: RatioRect; text: PageText } = recorded as { sub: RatioRect; text: PageText };
