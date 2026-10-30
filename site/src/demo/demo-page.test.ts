import { expect, it } from 'vitest';
import { groundTruthPageTexts } from '../../../src/testing/synthetic.ts';
import { DEMO_PAGE_ID } from './demo-page.ts';
import recorded from './demo-page.json' with { type: 'json' };

it('網站打包的辨識結果與譯文跟合成頁的 ground truth 一致（重新產生：node scripts/site-demo-page.ts）', () => {
  const [page] = groundTruthPageTexts(DEMO_PAGE_ID);
  expect(recorded).toEqual(page);
});
