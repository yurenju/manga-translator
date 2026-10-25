/**
 * 仿 Jump+ 的雛形：每頁一個 880×1280 的 canvas，圖片來自另一個 origin 所以 canvas 是 tainted；
 * 網址不會因為翻頁改變。RTL 翻頁動畫等之後的 ticket 需要時再加（可參考 prototype/overlay-render）。
 * header 有一個小 canvas 當網站 logo，用來確認太小的元素不會被當成 Page。
 * 全部頁面畫完後 body 會有 data-ready="true"。
 */
const PAGES = ['p01-basic', 'p02-ruby', 'p03-shapes', 'p04-outside', 'p05-dense', 'p06-horizontal'];

export function jumpPlusPage(imageOrigin: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>少年ジャンプ＋（模擬）</title>
<style>
  body { margin: 0; background: #f2f2f2; font-family: sans-serif; }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #fff; border-bottom: 1px solid #ddd; }
  header canvas { width: 120px; height: 32px; }
  .viewer { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px 0 300px; }
  .page { width: 430px; aspect-ratio: 880 / 1280; background: #fff; }
  .page canvas { width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<header><canvas id="logo" width="120" height="32"></canvas>少年ジャンプ＋（模擬）· 第 1 話</header>
<div class="viewer" id="viewer"></div>
<script>
  const imageOrigin = ${JSON.stringify(imageOrigin)};
  const pages = ${JSON.stringify(PAGES)};
  const viewer = document.getElementById('viewer');
  const logo = document.getElementById('logo').getContext('2d');
  logo.fillStyle = '#f5c800';
  logo.fillRect(0, 0, 120, 32);
  Promise.all(pages.map((id) => new Promise((resolve, reject) => {
    const slot = document.createElement('div');
    slot.className = 'page';
    const canvas = document.createElement('canvas');
    canvas.width = 880;
    canvas.height = 1280;
    slot.appendChild(canvas);
    viewer.appendChild(slot);
    const img = new Image(); // 沒有 crossOrigin：畫進 canvas 後就 tainted
    img.onload = () => { canvas.getContext('2d').drawImage(img, 0, 0); resolve(); };
    img.onerror = reject;
    img.src = imageOrigin + '/' + id + '.png';
  }))).then(() => { document.body.dataset.ready = 'true'; });
</script>
</body>
</html>`;
}
