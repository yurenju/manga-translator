# Chrome Web Store 上架資料

送審時照這份複製貼上到 Developer Dashboard。規則與出處見 [docs/research/chrome-web-store-listing.md](../research/chrome-web-store-listing.md)。

改了資料處理方式（送出的內容、連線對象、儲存的東西）時，這份、[PRIVACY.md](../../PRIVACY.md) 與 Dashboard 的 Privacy practices 要一起改。

## Store listing 分頁

| 欄位 | 內容 |
|---|---|
| 名稱 | `Naruhodo`（從 manifest 讀） |
| 摘要 | 從 manifest 的 `description` 讀（`src/manifest.ts`，最多 132 字） |
| 類別 | Tools |
| 語言 | 中文（繁體）。manifest 沒有 `_locales`，所以只有這一種語言的商店頁；英文放在詳細說明最後一段 |
| 截圖 | `docs/webstore/screenshot-*.png`（1280×800） |
| Small promo tile | `docs/webstore/promo-small.png`（440×280） |
| Homepage URL | https://github.com/yurenju/naruhodo-manga-translator |
| Support URL | https://github.com/yurenju/naruhodo-manga-translator/issues |

說明裡不寫特定漫畫網站的名稱：列網站名稱會被當成關鍵字堆砌（Yellow Argon），也牽涉商標。

### 詳細說明

```text
Naruhodo：邊看日文漫畫邊翻譯、邊學日文

點一下工具列圖示，Naruhodo 會找出畫面上的漫畫頁，把對話框直接換成繁體中文。翻頁或捲動時，新出現的頁面會自動翻譯。

■ 主要功能
・原地翻譯：譯文直接覆蓋在原本的對話框上，閱讀不中斷
・側邊欄逐字稿：依閱讀順序列出每句的原文、振り仮名與譯文，滑過對話框會同步標示
・學習模式：保留日文原稿，先看原文和讀音，想對答案時再揭露譯文
・跨頁支援：兩頁並排時自動分成兩頁各自翻譯
・作品筆記：自動整理角色名字與專有名詞，同一部作品的譯名前後一致
・翻譯快取：看過的頁面不用重翻，也不會重複花費
・匯出／匯入：在兩台電腦之間搬移作品、筆記與快取

■ 使用前須知
・需要你自己的 Claude API key（Anthropic）。翻譯費用由你的 Anthropic 帳戶支付，用 Claude Haiku 每頁大約不到一美分。沒有 key 也能用，但只會顯示原文與讀音。
・第一次使用時，會從 Hugging Face 下載文字辨識模型（大約 128 MB，支援 WebGPU 的電腦大約 472 MB）。
・需要 Chrome 116 以上。

■ 隱私
・對話框偵測和文字辨識（OCR）都在你的電腦上進行，圖片不會上傳。
・只有辨識出的文字會用你的 key 直接送到 Anthropic 翻譯，不會送網址。第一次使用前會先徵求你的同意。
・開發者沒有伺服器，收不到你的任何資料，外掛裡也沒有分析或追蹤程式。
・外掛只在你點圖示的那個分頁作用，不會在背景讀取其他網站。

■ 開源
原始碼以 MIT 授權公開在 GitHub：https://github.com/yurenju/naruhodo-manga-translator

---
English: Naruhodo translates Japanese manga on the current tab into Traditional Chinese, in place, and lists the original text, furigana readings and translation side by side for language learners. Detection and OCR run locally; only the recognized text is sent to Anthropic with your own API key.
```

## Privacy practices 分頁

### Single purpose

```text
Naruhodo translates Japanese manga shown in the current tab into Traditional Chinese and displays the translation in place over the original speech balloons. Text detection and OCR run locally in the browser; only the recognized Japanese text is sent to the Anthropic API, using the user's own API key, for translation.
```

### Permission justification

**activeTab**

```text
Naruhodo only works on a tab after the user clicks the toolbar icon or presses the keyboard shortcut. activeTab grants temporary access to that tab so the extension can inject its overlay script and capture the visible area (tabs.captureVisibleTab) to find and read manga text. We request no host permissions, so the extension has no access to any site the user has not explicitly activated it on.
```

**scripting**

```text
Used with activeTab to inject the extension's bundled content script (content.js) into the tab the user activated. The content script locates manga pages on screen and draws the translated text over the speech balloons. No content scripts are declared statically, so nothing is injected into pages the user has not activated.
```

**sidePanel**

```text
The side panel is the extension's main UI: it shows translation progress, the original text with readings, the per-series glossary (Series Notes), settings for the user's Anthropic API key, and import/export of the user's local data. It is opened when the user activates a tab.
```

**offscreen**

```text
An offscreen document crops the captured screenshots with canvas and runs the bundled ONNX Runtime Web (WebAssembly/WebGPU) for speech-balloon detection and OCR, then calls the Anthropic Messages API with the user's key. Service workers have no DOM/canvas and cannot run these long-lived tasks, so this work has to happen in an offscreen document.
```

**storage**

```text
Stores two small settings in chrome.storage.local: the user's Page Mode preference (single page or two-page spread), and whether the user has accepted the in-product data disclosure (with the policy version). No personal data is stored in chrome.storage.
```

**unlimitedStorage**

```text
On first use the extension downloads the OCR and text-detection model weights (about 128 MB, or about 472 MB when WebGPU is available) from Hugging Face and keeps them in Cache Storage so they are not downloaded again. It also keeps a local translation cache and glossary per manga series in IndexedDB. These exceed the default storage quota, and evicting the models would force repeated large downloads.
```

### Remote code

選「No, I am not using remote code」。

```text
All JavaScript and WebAssembly, including ONNX Runtime Web, is bundled in the package. The extension downloads ONNX model weights (data files, not code) from Hugging Face at a pinned revision and verifies their SHA-256 hashes.
```

### Data usage

| 類別 | 勾不勾 | 理由 |
|---|---|---|
| Website content | 勾 | 截圖與 OCR 文字；文字會送到 Anthropic |
| Authentication information | 勾 | 使用者的 Anthropic API key：存在本機，放在 header 送到 Anthropic |
| Web history | 勾 | 作品與網址對應（origin＋path）存在本機 |
| 其他類別 | 不勾 | 沒有收集 |

三項 Limited Use 聲明全部勾。

Privacy policy URL：https://github.com/yurenju/naruhodo-manga-translator/blob/main/PRIVACY.md

## Test instructions

每次送審都換一把新的測試 key（在 Anthropic Console 設花費上限），審核結束就撤銷。測試頁用一個不用登入就能看的日文漫畫免費話數。

```text
1. Open a Japanese manga page, for example: <TEST_PAGE_URL>
2. Click the Naruhodo toolbar icon (or press Alt+Shift+M). The side panel opens; accept the data disclosure card at the top.
3. In the side panel, open the gear menu → "API key 與模型" and paste this test key: <TEST_API_KEY>
   It has a spending cap and will be revoked after review.
4. Click the toolbar icon again. The first run downloads the OCR models (~128 MB), then the speech balloons are replaced with Traditional Chinese and the side panel lists the original text, readings and translations.

Source code (MIT): https://github.com/yurenju/naruhodo-manga-translator
```
