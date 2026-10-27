/**
 * 仿 Kindle（spec #27 第 12 節、#35）：整個 viewport 一張同源 blob `<img>`，是把整個 Spread（或單頁）等比例縮放、
 * 置中塞進 viewport 的合成圖，周圍是純黑邊；像素＝viewport × devicePixelRatio，視窗大小一變就重新產生（#35 實測）。
 * 翻頁是同一個 `<img>` 換 `src`（← 鍵＝下一頁、→ 鍵＝上一頁），body[data-page-index] 是目前第幾個畫面。
 * `#zoom` 是可以加 transform 的祖先（縮放／拖曳）；框架重繪由測試自己做（例如 `#zoom` 只留下 img）。
 * 圖片跟網站同 origin（canvas 不 tainted，才能 toBlob），放在 /kindle/img/。
 * 每次合成完、img 載入後 body 會有 data-ready="true"。
 *
 * 工具列（#55，仿真實 amazon manga 閱讀器）：上方書名列＋試讀橫幅、下方進度列、左右翻頁箭頭，疊在 img 上面。
 * 點畫面中間切換顯示。收起時跟真實閱讀器一樣先淡出（`fading`，半透明），比外掛的翻頁 debounce 久，之後才加上
 * `hidden`（display: none）。外掛截圖前會把工具列藏起來（#59）。img 是 `pointer-events: none`，
 * 上面蓋著一層全透明的感應層 `#tap`（真實閱讀器也是這樣接點擊）。
 * 網址參數：`toolbar=shown` 一開始就顯示工具列；`bg=white` 白底（合成圖的邊是白的）。
 */
export const KINDLE_VIEWS = ['p07-spread', 'p08-action', 'p01-basic'] as const;

export function kindlePage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Kindle（模擬）</title>
<style>
  html, body { margin: 0; overflow: hidden; background: #000; }
  body.white { background: #fff; }
  #zoom { width: 100vw; height: 100vh; transform-origin: 0 0; }
  #page { display: block; width: 100vw; height: 100vh; pointer-events: none; }
  #tap { position: absolute; inset: 0; }
  #chrome.hidden { display: none; }
  #chrome.fading { opacity: 0.5; }
  #chrome-top { position: absolute; top: 0; left: 0; right: 0; background: #fff; font: 16px sans-serif; }
  #chrome-top .title { height: 64px; line-height: 64px; padding: 0 16px; border-bottom: 1px solid #ddd; }
  #chrome-top .banner { height: 40px; line-height: 40px; text-align: center; color: #fff; background: rgb(177, 39, 4); }
  #chrome-bottom { position: absolute; bottom: 0; left: 0; right: 0; height: 60px; line-height: 60px; text-align: center; background: #fff; font: 16px sans-serif; }
  .chevron { position: absolute; top: calc(50% - 54px); width: 48px; height: 108px; border: 0; background: #fff; font: 32px sans-serif; }
  .chevron.left { left: 0; }
  .chevron.right { right: 0; }
</style>
</head>
<body>
<div id="app"><div id="zoom"><img id="page" alt=""></div></div>
<div id="tap"></div>
<div id="chrome">
  <div id="chrome-top"><div class="title">‹ ライブラリ　サンプル作品</div><div class="banner">期間限定 無料試し読み</div></div>
  <div id="chrome-bottom">1 / 3 ページ</div>
  <button class="chevron left" type="button">‹</button>
  <button class="chevron right" type="button">›</button>
</div>
<script>
  const views = ${JSON.stringify(KINDLE_VIEWS)};
  const params = new URLSearchParams(location.search);
  const background = params.get('bg') === 'white' ? '#fff' : '#000';
  document.body.classList.toggle('white', background === '#fff');
  const toolbar = document.getElementById('chrome');
  toolbar.classList.toggle('hidden', params.get('toolbar') !== 'shown');
  /** 淡出的時間：比外掛的翻頁 debounce（400 ms）久。 */
  const FADE_MS = 900;
  let fade;
  document.getElementById('tap').addEventListener('click', () => {
    clearTimeout(fade);
    if (toolbar.classList.contains('hidden') || toolbar.classList.contains('fading')) {
      toolbar.classList.remove('hidden', 'fading');
      return;
    }
    toolbar.classList.add('fading');
    fade = setTimeout(() => toolbar.classList.replace('fading', 'hidden'), FADE_MS);
  });
  const img = document.getElementById('page');
  let index = 0;
  let current;
  const sources = Promise.all(views.map((id) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = '/kindle/img/' + id + '.png';
  })));
  async function compose() {
    const source = (await sources)[index];
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(innerWidth * devicePixelRatio);
    canvas.height = Math.round(innerHeight * devicePixelRatio);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
    const w = Math.round(source.width * scale);
    const h = Math.round(source.height * scale);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - h) / 2), w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const previous = current;
    current = URL.createObjectURL(blob);
    document.body.dataset.ready = 'false';
    img.onload = () => {
      if (previous) URL.revokeObjectURL(previous);
      document.body.dataset.pageIndex = String(index);
      document.body.dataset.ready = 'true';
    };
    img.src = current;
  }
  document.addEventListener('keydown', (e) => {
    const next = e.key === 'ArrowLeft' ? index + 1 : e.key === 'ArrowRight' ? index - 1 : index;
    if (next === index || next < 0 || next >= views.length) return;
    index = next;
    void compose();
  });
  addEventListener('resize', () => void compose());
  void compose();
</script>
</body>
</html>`;
}
