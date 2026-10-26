/**
 * 仿 Kindle（spec #27 第 12 節、#35）：整個 viewport 一張同源 blob `<img>`，是把整個 Spread（或單頁）等比例縮放、
 * 置中塞進 viewport 的合成圖，周圍是純黑邊；像素＝viewport × devicePixelRatio，視窗大小一變就重新產生（#35 實測）。
 * 翻頁是同一個 `<img>` 換 `src`（← 鍵＝下一頁、→ 鍵＝上一頁），body[data-page-index] 是目前第幾個畫面。
 * `#zoom` 是可以加 transform 的祖先（縮放／拖曳）；框架重繪由測試自己做（例如 `#zoom` 只留下 img）。
 * 圖片跟網站同 origin（canvas 不 tainted，才能 toBlob），放在 /kindle/img/。
 * 每次合成完、img 載入後 body 會有 data-ready="true"。
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
  #zoom { width: 100vw; height: 100vh; transform-origin: 0 0; }
  #page { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<div id="app"><div id="zoom"><img id="page" alt=""></div></div>
<script>
  const views = ${JSON.stringify(KINDLE_VIEWS)};
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
    ctx.fillStyle = '#000';
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
