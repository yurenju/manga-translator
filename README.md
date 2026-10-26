# Manga Translator

一個 Chrome 外掛：把畫面上正在看的日文漫畫，原地翻成繁體中文，並在 side panel 列出原文、讀音（振り仮名）與譯文對照，可以邊看漫畫邊學日文。

已在 [少年ジャンプ+](https://shonenjumpplus.com/) 與 Amazon Kindle（日本）上驗證，但外掛不針對特定網站寫規則，理論上一般網頁上的漫畫圖片也能用。

## 功能

- **原地翻譯**：點工具列圖示（或按 `Alt+Shift+M`）後，外掛會找出畫面上的漫畫 Page，把譯文直接覆蓋在對話框上；翻頁或捲動時自動翻新出現的 Page。
- **side panel 逐字稿**：依閱讀順序列出每一句的原文、讀音與譯文；滑鼠移到頁面上的對話框，side panel 會同步標示對應的句子。可以切換顯示層級：只看譯文、原文＋譯文、加振り仮名（預設）、只看日文。
- **跨頁（Spread）**：兩頁並排顯示時會自動切成兩個 Page 各自翻譯。
- **作品筆記（Series Notes）**：翻譯時會累積角色名字、專有名詞、角色的自稱與說話方式，讓同一部作品前後翻譯一致；你也可以在 side panel 檢視與修正。
- **快取**：翻過的 Page 會存起來，重看同一頁不會再花錢呼叫 API。
- **匯出／匯入**：把作品、筆記與翻譯快取匯出成 JSON，在兩台電腦之間搬移（不含 API key）。

用語（Series、Page、Balloon 等）的定義見 [GLOSSARY.md](GLOSSARY.md)。

### 運作方式（簡述）

文字偵測與 OCR 都在你的電腦上跑（[onnxruntime-web](https://onnxruntime.ai/)，有 WebGPU 就用 WebGPU，沒有就退回 wasm），只有辨識出來的**文字**會送到 Claude API 做讀音與翻譯，圖片不會上傳。預設使用 Claude Haiku，每頁大約幾秒鐘、花費不到一美分。

外掛只在你點圖示的那個分頁上作用（`activeTab` 權限），不會在背景讀取其他網站。

## 安裝

目前還沒有上架 Chrome Web Store，需要自己從原始碼建置。

### 需要的東西

- [Node.js](https://nodejs.org/) 24 以上（建置腳本是直接用 Node 執行 TypeScript）
- Chrome 116 以上
- 一組 [Claude API key](https://console.anthropic.com/)（沒有 key 也能用，但只會顯示原文與讀音，不會翻譯）

### 1. 建置

```bash
git clone https://github.com/yurenju/manga-translator.git
```

```bash
cd manga-translator
```

```bash
npm install
```

```bash
npm run build
```

建置完成後，外掛會輸出在 `dist/prod/` 資料夾。

### 2. 在 Chrome 載入

1. 在網址列打開 `chrome://extensions`。
2. 打開右上角的「開發人員模式」（Developer mode）。
3. 按「載入未封裝項目」（Load unpacked），選擇剛剛的 `dist/prod/` 資料夾。
4. 建議把 Manga Translator 釘選到工具列，之後比較好點。

之後更新程式碼（例如 `git pull`）時，重新跑一次 `npm run build`，再到 `chrome://extensions` 按外掛卡片上的重新載入按鈕即可。

### 3. 設定 API key

1. 打開任一網頁，點工具列的 Manga Translator 圖示，side panel 會打開。
2. 在 side panel 的「⚙ 設定」貼上 Claude API key。

key 只存在這台電腦的外掛裡，不會交給網頁，也不會出現在匯出檔。建議在 Anthropic Console 為這個外掛建立專用的 key，並替它的 workspace 設定花費上限。

## 使用

1. 打開漫畫網站，翻到要看的那一話。
2. 點工具列圖示（或按 `Alt+Shift+M`）。side panel 會打開，畫面上的 Page 開始翻譯。
3. 照平常的方式翻頁或捲動，新出現的 Page 會自動翻譯。如果不想自動翻譯，可以在 side panel 關掉「自動翻譯」，改成需要時按「翻譯此頁」。

第一次使用時會從 Hugging Face 下載 OCR 模型，需要等一下；下載完會存在外掛裡，之後不用再下載。

## 開發

| 指令 | 用途 |
| --- | --- |
| `npm run build` | 正式 build，輸出到 `dist/prod/` |
| `npm run typecheck` | TypeScript 型別檢查 |
| `npm test` | 單元測試（Vitest） |
| `npm run e2e` | 用 mock 漫畫網站跑的 e2e 測試（Playwright） |
| `npm run debug:chrome` | 開一個載入 debug build 的 Chrome，並記錄整個流水線的 trace |

真實網站除錯見 [docs/agents/real-site-debugging.md](docs/agents/real-site-debugging.md)，架構決策見 [docs/adr/](docs/adr/)，程式碼規範見 [CODING_STANDARDS.md](CODING_STANDARDS.md)。

## 授權

[MIT](LICENSE)
