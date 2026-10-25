// PROTOTYPE — throwaway. 產生 data.js 給 index.html 用（file:// 不能 fetch JSON，所以包成 script）。
//
// 資料來源：branch prototype/claude55-api-compare 的 results/haiku-text/<id>.json
// （預設流水線「本機 OCR＋Haiku 5.5 文字模式」實際跑出的輸出，含真實的讀音錯誤）。
//
//   git show origin/prototype/claude55-api-compare:prototypes/claude55-api-compare-PROTOTYPE/results/haiku-text/p02-ruby.json > llm/p02-ruby.json
//   node build-data.mjs <llm 目錄>
//
// 依 #9 的形狀 {id, 讀音, 譯文, unreadable} 整理；src=bubble 的是 Balloon（會覆蓋），其他是 Loose Text（只進 side panel）。
// 這批輸出沒有 unreadable，所以手動把 p03-shapes 的黑底白字 Balloon 標成 unreadable 來看 UI（SIMULATED_UNREADABLE）。
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const PAGES = ['p01-basic', 'p02-ruby', 'p03-shapes', 'p04-outside', 'p05-dense', 'p06-horizontal', 'p07-spread'];
const SIMULATED_UNREADABLE = { 'p03-shapes': [5] }; // order（黑底白字「……誰だ」）

const pages = PAGES.map((id) => {
  const r = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  const gt = JSON.parse(fs.readFileSync(`../../testdata/synthetic/out/${id}.json`, 'utf8'));
  const texts = r.output.texts.map((t, i) => {
    const unreadable = (SIMULATED_UNREADABLE[id] || []).includes(t.order) || !!t.unreadable;
    return {
      id: `b${i + 1}`,
      order: t.order,
      isBalloon: t.src === 'bubble',
      kind: t.kind,
      bbox: t.bbox,
      orientation: t.orientation,
      ja: t.ja,
      reading: unreadable ? null : t.reading,
      zh: unreadable ? null : t.zh,
      unreadable,
    };
  });
  return { id, description: gt.description, image: `../../testdata/synthetic/out/${id}.png`, width: gt.width, height: gt.height, texts };
});

fs.writeFileSync('data.js', `// 由 build-data.mjs 產生，勿手改\nwindow.PAGES = ${JSON.stringify(pages, null, 1)};\n`);
console.log('wrote data.js', pages.map((p) => `${p.id}:${p.texts.length}`).join(' '));
