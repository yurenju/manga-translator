# Chrome MV3 外掛取得頁面圖片的通用方法

> Research for [#4](https://github.com/yurenju/manga-translator/issues/4)（map: [#1](https://github.com/yurenju/manga-translator/issues/1)）。
> 調查日期：2026-10-25。只查官方文件（developer.chrome.com、MDN）與 Chromium 原始碼；**沒有**在 Jump+ / Kindle 實站測試（那是另一張 ticket）。
> 限制：只處理畫面上已經顯示的內容，不繞過任何保護機制。

## TL;DR（建議）

1. **預設路徑：`chrome.tabs.captureVisibleTab` 截可視區域 → 用 content script 量到的 Page 元素 `getBoundingClientRect()` 裁切。** 這條路完全不碰 DOM 裡的圖片來源，所以不管網站用 `<img>`、`<canvas>`、blob URL、CSS background 還是拼接的圖塊，**只要畫面上看得到就拿得到**；也不受 tainted canvas / CORS 影響。這是最通用、也最符合「只處理已顯示內容」限制的方法。
2. 座標換算只需一個比例：**截圖像素 / CSS px ≈ `window.devicePixelRatio`**（已含 browser zoom 與 OS 縮放；pinch-zoom 要另外用 `visualViewport` 處理）。
3. **可選的高品質路徑（adapter 等級，不是預設）**：當 Page 是同源或有 CORS 的 `<img>` / 未 tainted 的 `<canvas>` 時，可以直接讀原始解析度像素。Tainted 時會丟 `SecurityError`，此時一律退回截圖，**不要**為了繞過 taint 改用 extension 的 host permission 重抓圖片。
4. 影像處理（裁切、縮放、WASM / WebGPU OCR）放在 **offscreen document**（或 side panel 本身）。Service worker 也能跑 WebGPU（Chrome 124+），但沒有 DOM、會被回收，不適合長時間工作。
5. 傳圖：Chrome 的 extension messaging 是 **JSON 序列化、單則上限 64 MiB**，不能直接傳 `ArrayBuffer` / `Blob`。可視區域的 JPEG data URL 通常是數百 KB 到數 MB，直接放進訊息即可。要給本機 server，**不要走 native messaging 傳圖**（host → Chrome 單則 1 MB 上限，而且是 JSON），改用 offscreen / side panel 對 `http://localhost` 做 `fetch` POST binary（需 host permission）。

## 比較表

| 方法 | 權限 | 能拿到什麼 | 解析度 | 受 tainted canvas / CORS 影響 | 頻率 / 成本 | 適合本專案嗎 |
|---|---|---|---|---|---|---|
| `tabs.captureVisibleTab` | `activeTab` 或 `<all_urls>` | 目前 window 的作用中 tab 的**可視區域**合成後畫面 | viewport CSS px × devicePixelRatio | 否 | 最多 **2 次/秒**；官方說「expensive」 | **預設方案** |
| 讀 `<img>` → canvas → `getImageData` / `toBlob` | 不需特別權限（content script） | 單張圖片原始像素 | 原圖解析度（可能比畫面高） | **是**：跨來源且無 CORS 就 `SecurityError` | 便宜 | 只在同源 / 有 CORS 時當加分 |
| 讀頁面的 `<canvas>` | 同上 | canvas 內容 | canvas backing store 解析度 | **是**：canvas 曾畫過跨來源圖就讀不出來 | 便宜 | 同上（很多閱讀器會 taint） |
| `fetch(blob:...)`（頁面建的 blob URL） | content script 在頁面 origin 執行 | blob 內容 | 原檔 | blob URL 綁 origin | 便宜 | 可能可行但有疑慮（見下文）；不建議當通用方法 |
| `tabCapture.getMediaStreamId` + `getUserMedia`（offscreen 播放、抓 frame） | `tabCapture`，需使用者觸發 | 整個 tab 的影片串流 | 依 constraints；有 video 壓縮 | 否 | 持續串流，CPU / 記憶體負擔大 | 過重；只有需要連續監看時才考慮 |
| `desktopCapture` / `getDisplayMedia` | `desktopCapture`，**每次都要使用者在 picker 選** | 螢幕 / 視窗 / tab | 同上 | 否 | 同上，且 UX 差 | 不適合 |

---

## 1. `chrome.tabs.captureVisibleTab`

來源：[chrome.tabs reference](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[extensionTypes reference](https://developer.chrome.com/docs/extensions/reference/api/extensionTypes)、Chromium [`web_contents_capture_client.cc`](https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/api/web_contents_capture_client.cc)、[`extension_types.json`](https://source.chromium.org/chromium/chromium/src/+/main:extensions/common/api/extension_types.json)。

- **簽名**：`chrome.tabs.captureVisibleTab(windowId?, options?) => Promise<string>`（Promise 版從 Chrome 88），回傳 **data URL**（base64）。
- **權限**：需要 `<all_urls>` **或** `activeTab`。`activeTab` 由使用者手勢授予（點 action、快捷鍵、context menu），只在那個 tab 有效、直到導航離開。`chrome:` 頁面、其他外掛頁面、`data:` URL 只能用 `activeTab` 截。若要「自動翻譯、預翻」不需每頁點擊，實務上要宣告 host permission（例如對 Jump+ / Kindle 網域，或 `<all_urls>`）。
- **只截作用中 tab**：截的是指定 window（預設 current window）中**目前作用中的 tab**的可視區域。背景 tab 截不到 → 「預翻後幾頁」若頁面不在畫面上，這條路做不到；必須等使用者翻到那頁（或網站本身已在 viewport 中渲染）。這跟「只處理已顯示內容」的限制一致。
- **速率限制**：`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2`（Chrome 92+）。官方註明此呼叫很貴，不要頻繁呼叫。本專案每頁數秒的延遲預算內，2 次/秒綽綽有餘。
- **格式**：`ImageDetails.format` = `"jpeg"`（預設）或 `"png"`；`quality` 0–100 只對 JPEG 有效，Chromium 預設 90。OCR / LLM 用途建議 PNG（無損，但檔案大）或高品質 JPEG。
- **解析度與 DPR**：Chromium 以 `view->CopyFromSurface(empty rect, ...)` 擷取整個 surface（「An empty rect will capture the entire surface」），結果是**裝置像素**。`extension_types.json` 中的註解說 scale「Defaults to devicePixelRatio」。所以輸出圖寬 ≈ viewport 寬（CSS px）× `devicePixelRatio`。
- **捕到什麼**：合成（composited）後的畫面——也就是使用者實際看到的，包括我們自己畫上去的 overlay。**注意**：截圖前要先隱藏自己的翻譯 overlay，否則會把譯文也截進去。是否包含捲軸要以 spike 確認（`window.innerWidth` 含捲軸寬，`document.documentElement.clientWidth` 不含）。
- **失敗情況**（原始碼）：view 不存在 → `FAILURE_REASON_VIEW_INVISIBLE`；企業政策禁止截圖或 DLP → `SCREEN_SHOTS_DISABLED(_BY_DLP)`。
- **驚喜：未公開的 `rect` / `scale` 欄位**。`extension_types.json` 的 `ImageDetails` 有標記 `nodoc: true` 的 `rect`（CSS px、相對頁面，省略則截 viewport）與 `scale`（預設 devicePixelRatio）；`web_contents_capture_client.cc` 確實會讀它們並傳進 `CopyFromSurface`。因為是 **nodoc**（不在公開文件、無相容性保證，可能僅供內部使用或有額外限制），**不要依賴**；若要用必須先 spike 驗證，並有 fallback（截全畫面再自行裁切）。

## 2. `chrome.tabCapture` / `desktopCapture` / `getDisplayMedia`

來源：[chrome.tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)、[chrome.desktopCapture](https://developer.chrome.com/docs/extensions/reference/api/desktopCapture)、[chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)。

- `tabCapture.getMediaStreamId({ targetTabId, consumerTabId })`（Chrome 71+）回傳一次性、幾秒內過期的 stream ID，交給 `getUserMedia({ video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId } } })`。Chrome 116+ 在 service worker 取得的 ID 可以在 **offscreen document** 使用。只有已取得 `activeTab`（使用者觸發）的 tab 能當 target。
- 得到的是 **video MediaStream**：要抓單張 frame 得再經 `<video>` / `ImageCapture` / `MediaStreamTrackProcessor`，影像經過影片編碼路徑，且持續佔資源。對「每頁拍一張」的需求是 overkill。
- `tabCapture.capture()` 標記為 foreground only（只能在擴充頁面前景呼叫），MV3 service worker 不能用。
- `desktopCapture.chooseDesktopMedia` / `getDisplayMedia`：**每次都要使用者在 picker 中選來源**，UX 不適合。Offscreen 有 `DISPLAY_MEDIA` / `USER_MEDIA` reason 可以承載這些串流。
- 結論：只有在未來需要「連續偵測翻頁」時才值得評估 tabCapture；第一版用 `captureVisibleTab` 即可。

## 3. 從 content script 讀 img / canvas / blob URL

來源：[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、MDN [Allowing cross-origin use of images and canvas](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image)。

- Content script 在 **isolated world** 執行：跟頁面**共享 DOM**，但不共享 JS 變數。所以能拿到 `<img>`、`<canvas>` 元素、讀 `src`、`naturalWidth`，但看不到頁面 JS 裡的變數（例如閱讀器內部解碼好的 bitmap）。
- Content script 可直接用的 extension API 很少：`dom`、`i18n`、`storage`、`runtime.connect/sendMessage/onMessage/getURL/...`。**不能**直接呼叫 `tabs.captureVisibleTab`，要發訊息請 service worker 截。
- **Tainted canvas 規則（MDN）**：把未經 CORS 核准的跨來源資料畫進 canvas 後，canvas 就被 taint；之後 `getImageData()`、`toBlob()`、`toDataURL()`、`captureStream()` 都丟 `SecurityError`。`drawImage()` 本身不會失敗。`<img crossorigin="anonymous">` + 伺服器回 `Access-Control-Allow-Origin` 才能不 taint。
- **Host permission 不會解除 content script 的同源限制**：官方原文「Cross-origin requests are always treated as such in content scripts, even if the extension has host permissions.」Content script 在頁面 origin 下執行，所以它畫進 canvas 的跨來源圖片照樣 taint。
- **Extension 頁面 / service worker / offscreen 有 host permission 時可以跨來源 fetch**。技術上可以用這個從 extension origin 重新下載圖片 URL 來避開 taint——**本專案不做**：這等於在頁面之外另外下載內容，對有 DRM / 保護的閱讀器（例如 Kindle 的 canvas 呈現、Jump+ 的圖片打亂與重組）就是繞過保護機制，違反 map #1 的 out-of-scope。
- **Blob URL**：頁面以 `URL.createObjectURL` 建的 `blob:` URL 綁定建立者的 origin。Content script 在頁面 origin 執行，理論上可 `fetch` 它，但（a）通常閱讀器的 blob 是打亂 / 加密過的中間產物，不是畫面上看到的樣子；（b）讀取未顯示的原始資源已接近「下載受保護內容」。**不建議**當通用方法。
- 結論：DOM 讀像素只當「同源或 CORS-enabled 的一般 `<img>`」時的品質加分；**通用路徑一律用截圖**。DOM 仍然有用——用來**定位** Page 元素（bounding box），不是用來取像素。

## 4. Offscreen document（MV3 的影像處理環境）

來源：[chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)、[What's New in WebGPU (Chrome 124)](https://developer.chrome.com/blog/new-in-webgpu-124)。

- 需要 `"offscreen"` 權限，Chrome 109+。`chrome.offscreen.createDocument({ url, reasons, justification })`，`url` 必須是外掛內的靜態 HTML。
- **一次只能有一個** offscreen document（split incognito 模式下 normal / incognito 各一）。要先檢查是否已存在：`runtime.getContexts()`（Chrome 116+）或 `offscreen.hasDocument()`（Chrome 150+）。
- Reasons 包括 `BLOBS`、`DOM_PARSER`、`WORKERS`、`USER_MEDIA`、`DISPLAY_MEDIA`、`WEB_RTC`、`CLIPBOARD`、`LOCAL_STORAGE` 等 15 種。影像處理可用 `BLOBS`（`createObjectURL`）、`WORKERS`（開 Worker 跑 WASM）。只有 `AUDIO_PLAYBACK` 有生命週期限制（30 秒無聲音自動關閉），其他 reason 沒有。
- Offscreen 內**只有 `chrome.runtime`** 這個 extension API；溝通一律走 `runtime` messaging。是 `window`、有 DOM（`OffscreenCanvas`、`createImageBitmap`、`<canvas>` 都可用），不能 focus。
- **WebGPU**：Chrome 124 起 WebGPU 可在 service worker 與 shared worker 使用，官方舉 extension service worker 與 WebLLM extension 為例。offscreen document 本身是一般 document，WebGPU / WASM 可用（文件未特別限制）。但 service worker 會在閒置時被回收，長時間的 OCR / 模型推論放 **offscreen 或 side panel** 比較穩。
- 本專案的建議分工：
  - side panel 開著時，影像處理可直接在 side panel 做（它本來就是 extension page，有完整 Chrome API）。
  - 需要在背景（side panel 未開）處理時才建 offscreen document。

## 5. 座標換算：截圖像素 ↔ 頁面 / 元素座標

來源：MDN [`devicePixelRatio`](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)、[Visual Viewport API](https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API)、[`getBoundingClientRect`](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect)、[chrome.tabs zoom](https://developer.chrome.com/docs/extensions/reference/api/tabs)。

關鍵事實：

- **Browser zoom 會改變 `devicePixelRatio`**（放大時 CSS px 變大，DPR 變大）；**pinch-zoom 不會**改變 DPR。OS 縮放（Windows 150%、Retina 2x）也反映在 DPR。DPR 改變（例如視窗拖到另一個螢幕）可用 `matchMedia('(resolution: Xdppx)')` 的 `change` 事件偵測。
- `chrome.tabs.getZoom(tabId)` / `onZoomChange` 可在 service worker 端拿到 tab zoom，但 content script 端用 DPR 已足夠。
- `getBoundingClientRect()` 相對 **(layout) viewport 左上角**，已扣除捲動；加 `scrollX/scrollY` 才是 document 座標。
- CSS transform：`getBoundingClientRect()` 回傳的是 transform 後的**軸對齊外接矩形**（這點 MDN 頁面未明寫，屬 CSSOM View 行為）。漫畫閱讀器常用 `scale()` / `translate()`，純縮放平移時外接矩形就是真實位置；有旋轉時要自己用 `DOMMatrix` / `getComputedStyle().transform` 算四角。
- Pinch-zoom：visual viewport 相對 layout viewport 有 `visualViewport.offsetLeft/offsetTop` 與 `scale`。截圖截的是**使用者看到的** visual viewport。

換算公式（同一時間點在 content script 量測，並跟截圖一起送出）：

```
ratio = devicePixelRatio * visualViewport.scale            // 截圖像素 / CSS px
x_img = (rect.left - visualViewport.offsetLeft) * ratio
y_img = (rect.top  - visualViewport.offsetTop)  * ratio
```

實務驗證法：`ratio_measured = capturedImage.width / visualViewport.width`（或 `/ document.documentElement.clientWidth`），跟 `devicePixelRatio` 比對，誤差大就以實測為準。Pinch-zoom 下的精確行為與捲軸是否被截入需要 spike 驗證。

反向（把 Balloon 從截圖座標對回頁面以放 overlay）：**不要存 viewport 座標**，要存成**相對於 Page 元素的比例座標**（0–1），overlay 掛在 Page 元素上（或用 `ResizeObserver` / `IntersectionObserver` 跟著它），這樣捲動、zoom、版面變動都不用重新截圖。

注意 race condition：截圖是非同步的（content script → service worker → capture），中間使用者若捲動，量測的 rect 就過期了。做法：截圖前後各量一次 rect，不一致就重拍；或截圖期間暫停自動處理直到 `scrollend`。

## 6. Side Panel API

來源：[chrome.sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)。

- 權限 `"sidePanel"`；manifest `side_panel.default_path`。`setPanelBehavior({ openPanelOnActionClick: true })` 讓點 action 開 panel（預設 off）。
- **Per-tab panel**：`setOptions({ tabId, path, enabled })` 可針對單一 tab 設定；不帶 `tabId` 是全域預設。`enabled: false` 會在該 tab 隱藏 panel。同 path 的 tab-specific 與全域 panel 是**不同實例**。→ 可做「只有在支援的 Series 頁面才啟用 panel」。
- `open({ tabId | windowId })`（Chrome 116+）**必須由使用者動作觸發**（action click、快捷鍵、context menu、extension page 或 content script 中的 user gesture）。`close()`（141+）、`onOpened`（141+）/`onClosed`（142+）、`getLayout()`（140+，左/右）。
- Side panel 是 extension page，**可使用所有 Chrome API**（可以直接呼叫 `tabs.captureVisibleTab`、`tabs.sendMessage`、`fetch` localhost）。這讓「side panel 當主控台」很自然：side panel 叫 content script 量 rect → side panel 自己截圖 → 自己裁切 / 送 server。
- 溝通：官方 side panel 頁沒寫專門機制，就用一般 `runtime` / `tabs` messaging（見下節）。Side panel 關閉時頁面被銷毀，背景任務不能只依賴 side panel → 需要 service worker / offscreen 當後備。

## 7. 大量圖片資料的傳輸

來源：[Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)、[Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)。

- **Chrome 的 extension messaging 用 JSON 序列化**（不是 structured clone，這點跟 Firefox 不同）；`undefined` 會變 `null`。**單則上限 64 MiB**。`ArrayBuffer` / `Blob` / `ImageBitmap` **不能**直接傳（會被當普通物件 JSON 化成無用的 `{}`）。→ 傳圖用 data URL / base64 字串（`captureVisibleTab` 本來就回 data URL）。Base64 膨脹約 33%。
- 粗估：2560×1440（DPR 2 的筆電）可視區域，JPEG q90 約數百 KB～2 MB；PNG 可能 3～8 MB。都遠低於 64 MiB，所以**直接 messaging 即可**，不需要複雜的分段機制。
- 減少傳輸的技巧：在**截圖的那一端就裁切**到 Page 的範圍（side panel / offscreen 內用 `createImageBitmap(blob, sx, sy, sw, sh)` 或 `OffscreenCanvas`），只傳 Page 區域。
- 同 extension origin 的頁面（side panel、offscreen、popup）共用 `chrome-extension://<id>` origin，可以共用 IndexedDB 存 Blob，訊息裡只傳 key——避免 JSON / base64 成本。Content script 的 IndexedDB 是**頁面 origin 的**，不共用。（`blob:` URL 能否跨 extension 的不同 document 使用需 spike 驗證。）
- **Native messaging 不適合傳圖**：Chrome → host 單則最大 64 MiB，但 **host → Chrome 單則最大 1 MB**；格式是 JSON + 32-bit 長度前綴。`connectNative` 保持 host 程序存活直到 port 關閉；`sendNativeMessage` 每則訊息都開一個新程序。→ Native messaging 很適合當「**按需啟動本機 server**」的開關（符合 map 的「不常駐、需要時才啟動」），但圖片本身應改走 HTTP。
- **送到本機 server**：extension page / service worker / offscreen 只要有該 host 的 host permission（例如 `http://localhost:*/*` 或 `http://127.0.0.1/*`），就能跨來源 `fetch` POST binary（`Blob` / `ArrayBuffer` body，不需 base64）。Content script 則不行（受頁面 origin 限制），所以 POST 要由 side panel / offscreen / service worker 發。

## 建議的通用流程（草案，非實作）

```
使用者觸發（side panel 按鈕 / action / 快捷鍵）
  └─ side panel（或 SW）→ tabs.sendMessage → content script
       ├─ 找出畫面中的 Page 元素（通用啟發式：可見面積最大的 img/canvas/背景圖元素；adapter 可覆寫）
       ├─ 隱藏自己的 overlay
       └─ 回傳 { rect（CSS px）, devicePixelRatio, visualViewport{offset, scale, width} }
  └─ side panel：tabs.captureVisibleTab({format:'png'}) → data URL
       ├─ 用 ratio 裁切成 Page 圖（OffscreenCanvas）
       └─ fetch POST 到 localhost server（或交給 Claude Code 流程）
  └─ 結果（Balloon 座標以 Page 元素的 0–1 比例表示）→ content script 掛 overlay
```

## 尚待 spike 驗證的事項

- `captureVisibleTab` 輸出寬度 vs `innerWidth`/`clientWidth`×DPR：是否含捲軸、Windows 150% 縮放下的四捨五入誤差。
- Pinch-zoom（觸控板）下截圖與 `visualViewport` 的對應。
- 未公開 `ImageDetails.rect` / `scale` 是否真的對 extension 可用（不打算依賴）。
- Jump+ / Kindle 的 Page 元素是什麼（canvas？img？多張拼接？）——由實站 ticket 負責。
- `blob:` URL 能否在 offscreen 與 side panel 間共用。

## Sources

- chrome.tabs: https://developer.chrome.com/docs/extensions/reference/api/tabs
- extensionTypes (ImageDetails): https://developer.chrome.com/docs/extensions/reference/api/extensionTypes
- Chromium `web_contents_capture_client.cc`: https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/api/web_contents_capture_client.cc
- Chromium `extension_types.json`: https://source.chromium.org/chromium/chromium/src/+/main:extensions/common/api/extension_types.json
- chrome.tabCapture: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- chrome.desktopCapture: https://developer.chrome.com/docs/extensions/reference/api/desktopCapture
- chrome.offscreen: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- chrome.sidePanel: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Cross-origin network requests: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- Message passing: https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- Native messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- What's New in WebGPU (Chrome 124): https://developer.chrome.com/blog/new-in-webgpu-124
- MDN CORS-enabled image / tainted canvas: https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image
- MDN devicePixelRatio: https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio
- MDN Visual Viewport API: https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API
- MDN getBoundingClientRect: https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect
