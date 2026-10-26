# 用通用方法定位 Page、以影像 hash 辨識 Page，外掛只在使用者點圖示的 tab 上啟動

v1 沒有網站 adapter。Page 的定位、翻頁偵測、Page 的身分都用同一套通用方法，在 Jump+ 與 Kindle 上都能運作（[#18](https://github.com/yurenju/manga-translator/issues/18)）。兩個網站翻頁都不改 URL，也不一定有單一 Page 元素（[#5](https://github.com/yurenju/manga-translator/issues/5)），所以 Page 是用畫面上的影像來辨識，不靠網址或頁碼。外掛預設對任何網站都不動作，使用者對某個 tab 點外掛圖示（或按快捷鍵）時才啟動。

## 做法

- **定位 Page**：可視區域裡夠大的 `<img>` / `<canvas>`，每個元素是一個 Page 候選（「完整可見」也要在每個會裁切的祖先裡面，見 [ADR 0004](0004-fully-visible-page-inside-every-clipping-ancestor.md)）。看起來是 Spread 的候選（寬 > 高）在 offscreen document 去暗色邊緣、找中縫，切成兩個 Page；寬 > 高卻切不開的候選這次不產生 Page（[#55](https://github.com/yurenju/manga-translator/issues/55)）。白邊不去：會連頁面本身的留白一起切掉，OCR 的輸入和 hash 都會變。Jump+ 是每頁一個 canvas，Kindle 是整個 viewport 合成一張 img。
- **偵測翻頁**：DOM mutation、scroll、resize、按鍵、點擊、img load 等訊號經過 debounce（約 300–500 ms）後截圖，再比對每個 Page 的縮圖 hash，hash 變了才算翻頁。不做定時輪詢。
- **Page 的身分**：快取 key 是 `(Series, Page 影像的 perceptual hash)`，比對時用 Hamming 距離門檻。同一個 Page 在不同網站讀，會命中同一筆快取。
- **覆蓋座標**：Balloon 框存成相對 Page 的 0～1 比例座標。每個 Page 記一個 anchor 元素，Spread 另外記 `subRect`（例如左半）。渲染時用 anchor 目前的 rect 換算成畫面座標。
- **啟動**：在 `action.onClicked`（或 `commands`）裡呼叫 `sidePanel.open()`，同時注入 content script。啟動狀態維持到 `activeTab` 授權結束（換 origin、關 tab）或使用者按「停止」為止。關掉 side panel 不會停止，同 origin 重新整理後自動重新注入。記住的網址模式只用來預選 Series，不會自動啟動。
- **權限**：只宣告 `activeTab` + `scripting` + `sidePanel`，沒有 `<all_urls>`，也沒有靜態 `content_scripts`。

## 不直覺的地方

- **刻意不用 `sidePanel.setPanelBehavior({openPanelOnActionClick: true})`。** 用了以後點圖示**不會**給 `activeTab`，`captureVisibleTab` 就不能用（要 `activeTab` 或真的授予 `<all_urls>`）。從 Chrome 內建的 side panel 選單打開外掛也拿不到授權，這時 side panel 只會提示使用者點圖示。
- **不做「記住網站、自動翻譯」。** `captureVisibleTab` 不吃單一網站的 host permission，要自動啟動就必須要求 `<all_urls>`。v1 選擇不要求這個權限。
- **Page 的身分不是頁碼。** 沒有 adapter 就拿不到可靠的 Episode / 頁碼。影像 hash 是近似比對，全白或幾乎全黑的頁可能互撞，但這類頁通常沒有文字，翻錯的代價很小。之後如果改用網站提供的 id，就要重建快取。

## 先不做

網站 adapter：等遇到通用方法處理不了的網站再設計。可以覆寫的點會是「找 Page」、「翻頁偵測」、「Page key」，其他段落（擷取、偵測、OCR、翻譯）都不會交給 adapter。
