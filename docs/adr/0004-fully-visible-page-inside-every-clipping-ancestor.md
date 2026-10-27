# 「完整可見」的 Page 要落在 viewport 與每一個會裁切的祖先裡面

[ADR 0003](0003-page-location-and-activation.md) 定位 Page 的方法是「可視區域裡夠大的 `<img>` / `<canvas>`」。翻頁式的 viewer（仿 Jump+ 的 `?mode=paged`、真的 Jump+ 翻頁模式）把每一頁都放在同一個 `overflow: hidden` 的容器裡，用 `transform` 左右移動；隔壁頁的 `getBoundingClientRect()` 常常整個落在 viewport 裡，但被容器裁掉、畫面上看不到。只看 viewport 的話，隔壁頁會被當成 Page 截圖、跑 OCR、翻譯，覆蓋層也會蓋在看不到的元素上（[#34](https://github.com/yurenju/manga-translator/issues/34)）。

## 決定

Page 候選要**完整可見**：rect 落在 viewport 裡，**而且**落在每一個 `overflow-x` 或 `overflow-y` 不是 `visible` 的祖先（到 `<body>` 為止，不含 `<html>`／`<body>`）的 rect 裡，各邊容許 `VIEWPORT_TOLERANCE`（4 CSS px）。content script 量出這些祖先的 rect（`clipRects`），判斷本身（`isPageCandidate`）只吃 rect，維持可以單元測試。

## 不直覺的地方

- **捲動容器也算裁切。** `overflow: auto / scroll` 的容器裡捲到一半、被切掉一截的 Page 不算候選，等捲到完整可見才擷取；這跟 viewport 的規則一致（只翻完整看得到的頁）。
- **只看 overflow，不看其他裁切方式。** `clip-path`、`mask`、`contain: paint` 都沒有處理；遇到用這些方式藏起隔壁頁的網站再說。被其他元素蓋住不影響是不是候選，截圖前另外處理（下一節）。
- **每次量測都要對每個候選往上走一遍祖先、讀 `getComputedStyle`。** 候選只有畫面上夠大的 img／canvas，數量很少，v1 接受這個成本。
- **同步量測。** `IntersectionObserver` 也會扣掉祖先的裁切，但它是非同步回報；`scan.ts` 在截圖前後各量一次、不同就重試，需要當下就拿到結果，所以直接量 rect。

## 被其他元素蓋住：截圖前藏起來（#55、#59）

Kindle 的閱讀器把工具列（書名列、試讀橫幅、進度列、翻頁箭頭）疊在整個 viewport 大小的 img 上面；截到的 Page 會帶著 UI，Balloon 被蓋掉一截，OCR 缺字，hash 也對不上（[#55](https://github.com/yurenju/manga-translator/issues/55)）。#55 原本的做法是「被有畫東西的元素蓋住就不截，side panel 提示使用者收起」，但在真實 Jump+ 誤判：翻頁感應區是透明、各蓋半個畫面的 `<a>`，只有貼在畫面邊緣的小箭頭背景圖，整塊被當成遮擋物，整頁都不翻（[#59](https://github.com/yurenju/manga-translator/issues/59)）。

所以改成**一律截圖，截圖前把疊在 Page 上的元素暫時藏起來**：content script 在每個 anchor 的 rect 內格點取樣 `elementsFromPoint`，hit test 堆疊裡排在 anchor 前面的元素就是遮擋物（`occlusion.ts`），用 `document.adoptedStyleSheets` 加一張樣式表把它們設成 `opacity: 0 !important; transition: none !important`，等重繪完才截，截完立刻拿掉（`capture.ts`）。真實網站上量到：Jump+ 漫畫範圍內跟原圖 0 個像素不同；Kindle 工具列開著時藏起來截的圖跟使用者手動收起後截的 0 個像素不同；找遮擋物＋套樣式 3～9 ms，不產生 mutation。

- **不判斷「有沒有畫東西」。** 以整個元素為單位判斷會被大塊透明、只畫一角的元素騙；排在前面的全藏掉，透明的藏了也看不出差別。
- **取樣時讓所有元素都接受點擊測試**（`* { pointer-events: auto !important }`）。Kindle 的 img、浮水印、遮罩常是 `pointer-events: none`，`elementsFromPoint` 會跳過它們，就分不出誰在誰上面，浮水印會被截進去。同步加上、量完立刻拿掉，瀏覽器沒機會拿它算 hover。
- **不能加 attribute 或改 `style`**：會產生 mutation，觸發自己的翻頁偵測、變成無窮迴圈。所以樣式表用結構路徑 selector（`:root > body:nth-child(2) > … > a:nth-child(1)`）；截完再用同一組 selector 確認選到的還是同一批元素，不是的話（藏著的期間頁面換了元素）丟掉這張截圖重截，跟「截圖前後量到的版面不同就重試」同一個機制。
- **有些元素不藏**：包含 anchor 的祖先；自己的覆蓋層（另外照原本方式藏，已記下「帶覆蓋層的樣子」時不藏，但網站的遮擋物照樣藏）；`img`／`canvas`／`video`，可能是漫畫本身（Kindle 的 DOM 裡左右兩側各有一張預載的頁面 img）。包含其他 Page 候選的容器不藏本身，往下改藏它的子元素。藏不掉的就照截，不等待。
- **截圖期間遮擋物會消失一下**（真實 Chrome 截一次 1～2 秒）。Kindle 的工具列會閃一下；比起整頁不翻，接受這個代價。
- **比取樣間距小的遮擋物可能漏掉。** v1 接受這個取捨。
- **不採用的做法**：直接讀 img／canvas 的像素（Jump+ 的 canvas 是 tainted）、fetch 原圖（Jump+ 的圖是切碎重排的）、Element Capture、`chrome.debugger`：要每個網站專屬程式，或體驗很差。
