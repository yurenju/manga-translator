/**
 * 仿 Jump+：每頁一個 880×1280 的 canvas，圖片來自另一個 origin 所以 canvas 是 tainted；
 * 網址不會因為翻頁改變。預設縱向排列；paged（`?mode=paged`，#34）是 RTL 翻頁：`overflow:hidden` 的
 * viewer 一次只露一頁，隔壁頁在 viewer 外面（rect 在畫面內但被裁掉），翻頁是 450 ms 的 transform 動畫
 * （參考 prototype/overlay-render 的 buildJumpPlus）。← 鍵或點左半＝下一頁，→ 鍵或點右半＝上一頁；
 * body[data-page-index] 是目前第幾頁（0 起算）。
 * header 有一個小 canvas 當網站 logo，用來確認太小的元素不會被當成 Page。
 * 全部頁面畫完後 body 會有 data-ready="true"。
 *
 * 疊在 Page 上的元素（#59，網址參數，可以同時開）：
 * - `nav=1`：真實 Jump+ 的翻頁感應區。透明、各蓋半個畫面的 `<a>`，背景圖是貼在畫面左右邊的小箭頭（`no-repeat`），
 *   `opacity: 0.2`；#55 的「有畫東西就算遮擋」把整塊當成遮擋物，整頁都不翻。
 * - `watermark=1`：第 1 頁上方三分之一蓋一塊 `pointer-events: none` 的半透明洋紅浮水印（`#watermark`），上面有字。
 * - `stacked=1`：第 1 頁上疊一張 120×120 的青色 `<img>`（`#stacked`），太小不算 Page，但不能被藏掉（可能是漫畫本身）。
 */
const PAGES = ['p01-basic', 'p02-ruby', 'p03-shapes', 'p04-outside', 'p05-dense', 'p06-horizontal'];

export const WATERMARK_TEXT = 'サンプル透かし';

const ARROW = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="27" height="49.5"><path d="M24 2 3 24.75 24 47.5" fill="none" stroke="#000" stroke-width="4"/></svg>')}`;
const CYAN = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#0ff"/></svg>')}`;

export function jumpPlusPage(imageOrigin: string, { paged = false, nav = false, watermark = false, stacked = false } = {}): string {
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
  .viewer.paged { display: block; position: relative; width: 430px; height: 625px; margin: 16px auto 300px; padding: 0; overflow: hidden; }
  .paged .track { display: flex; flex-direction: row-reverse; position: absolute; right: 0; top: 0; transition: transform 450ms ease; }
  .paged .page { flex: none; }
  .page-navigation-forward, .page-navigation-backward { position: fixed; top: 0; width: 50vw; height: 100vh; opacity: 0.2;
    background: url("${ARROW}") no-repeat; background-size: 27px 49.5px; }
  .page-navigation-forward { left: 0; background-position: left 8px center; }
  .page-navigation-backward { right: 0; background-position: right 8px center; transform: scaleX(-1); }
  #watermark { position: absolute; left: 0; right: 0; top: 33.3%; height: 33.3%; pointer-events: none; background: rgba(255, 0, 255, 0.5); color: rgba(0, 0, 0, 0.6);
    font: bold 40px sans-serif; display: flex; align-items: center; justify-content: center; }
  #stacked { position: absolute; right: 40px; bottom: 40px; width: 120px; height: 120px; }
</style>
</head>
<body>
<header><canvas id="logo" width="120" height="32"></canvas>少年ジャンプ＋（模擬）· 第 1 話</header>
<div class="viewer${paged ? ' paged' : ''}" id="viewer">${paged ? '<div class="track" id="track"></div>' : ''}</div>
${nav ? '<a class="page-navigation-forward rtl"></a><a class="page-navigation-backward rtl"></a>' : ''}
<script>
  const imageOrigin = ${JSON.stringify(imageOrigin)};
  const pages = ${JSON.stringify(PAGES)};
  const viewer = document.getElementById('track') ?? document.getElementById('viewer');
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
  // 疊在第 1 頁的 canvas 上：放在 canvas 後面的兄弟元素，跟著頁面移動
  const first = document.querySelector('.page');
  const extras = ${JSON.stringify(
    (watermark ? `<div id="watermark">${WATERMARK_TEXT}</div>` : '') + (stacked ? `<img id="stacked" alt="" src="${CYAN}">` : ''),
  )};
  if (extras) {
    first.style.position = 'relative';
    first.insertAdjacentHTML('beforeend', extras);
  }
  if (${paged}) {
    let index = 0;
    document.body.dataset.pageIndex = '0';
    const turn = (delta) => {
      index = Math.max(0, Math.min(pages.length - 1, index + delta));
      viewer.style.transform = 'translateX(' + index * 430 + 'px)';
      document.body.dataset.pageIndex = String(index);
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') turn(1);
      if (e.key === 'ArrowRight') turn(-1);
    });
    document.getElementById('viewer').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      turn(e.clientX < r.x + r.width / 2 ? 1 : -1);
    });
  }
</script>
</body>
</html>`;
}
