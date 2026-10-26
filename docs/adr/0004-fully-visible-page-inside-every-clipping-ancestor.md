# 「完整可見」的 Page 要落在 viewport 與每一個會裁切的祖先裡面

[ADR 0003](0003-page-location-and-activation.md) 定位 Page 的方法是「可視區域裡夠大的 `<img>` / `<canvas>`」。翻頁式的 viewer（仿 Jump+ 的 `?mode=paged`、真的 Jump+ 翻頁模式）把每一頁都放在同一個 `overflow: hidden` 的容器裡，用 `transform` 左右移動；隔壁頁的 `getBoundingClientRect()` 常常整個落在 viewport 裡，但被容器裁掉、畫面上看不到。只看 viewport 的話，隔壁頁會被當成 Page 截圖、跑 OCR、翻譯，覆蓋層也會蓋在看不到的元素上（[#34](https://github.com/yurenju/manga-translator/issues/34)）。

## 決定

Page 候選要**完整可見**：rect 落在 viewport 裡，**而且**落在每一個 `overflow-x` 或 `overflow-y` 不是 `visible` 的祖先（到 `<body>` 為止，不含 `<html>`／`<body>`）的 rect 裡，各邊容許 `VIEWPORT_TOLERANCE`（4 CSS px）。content script 量出這些祖先的 rect（`clipRects`），判斷本身（`isPageCandidate`）只吃 rect，維持可以單元測試。

## 不直覺的地方

- **捲動容器也算裁切。** `overflow: auto / scroll` 的容器裡捲到一半、被切掉一截的 Page 不算候選，等捲到完整可見才擷取；這跟 viewport 的規則一致（只翻完整看得到的頁）。
- **只看 overflow，不看其他裁切方式。** `clip-path`、`mask`、`contain: paint`、被其他元素蓋住都沒有處理；遇到用這些方式藏起隔壁頁的網站再說。
- **每次量測都要對每個候選往上走一遍祖先、讀 `getComputedStyle`。** 候選只有畫面上夠大的 img／canvas，數量很少，v1 接受這個成本。
- **同步量測。** `IntersectionObserver` 也會扣掉祖先的裁切，但它是非同步回報；`scan.ts` 在截圖前後各量一次、不同就重試，需要當下就拿到結果，所以直接量 rect。
