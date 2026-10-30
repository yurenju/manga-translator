/** 產生產品網站首頁展示（#109）用的辨識結果與譯文：site/src/demo/demo-page.json。 */
import { writeFileSync } from 'node:fs';
import { DEMO_PAGE_ID } from '../site/src/demo/demo-page.ts';
import { groundTruthPageTexts } from '../src/testing/synthetic.ts';

const [page] = groundTruthPageTexts(DEMO_PAGE_ID);
writeFileSync(new URL('../site/src/demo/demo-page.json', import.meta.url), `${JSON.stringify(page, null, 2)}\n`);
