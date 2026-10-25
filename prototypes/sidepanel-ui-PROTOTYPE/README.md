# PROTOTYPE：Side panel 與學習模式 UI（#21）

Throwaway，不會 merge。回答的問題：Side panel 長什麼樣子？學習模式怎麼逐層打開 原文／讀音／譯文？

## 跑起來

在 repo 根目錄：

```bash
python -m http.server 8721
```

開 <http://localhost:8721/prototypes/sidepanel-ui-PROTOTYPE/index.html?variant=A&page=p02-ruby>

- 底部黃框浮動列或 `←` `→` 切換變體；上方 `Page` 選合成頁；「模擬」選單切成「Series Notes 剛更新」「未選 Series」。
- `p01-basic` 一開始是「未翻譯」，可以按「翻譯此頁」看流程；`p03-shapes` 的「……誰だ」被手動標成 `unreadable`。

## 三個變體

| | 結構 | 逐層打開 | 頁面 ↔ panel | 翻譯入口 |
|---|---|---|---|---|
| **A 卡片清單** | 每個 Balloon 一張卡（含裁圖縮圖），Loose Text 收在下方摺疊區 | 每張卡自己開：譯文 → 原文 → 讀音；頂部可一次全展開到某層 | hover 頁面 Balloon → 卡片高亮並捲到；點頁面 Balloon 逐層打開 | 頂部 header |
| **B 逐字稿** | 一行一句、依閱讀順序，Loose Text 用斜體 🔊 混在裡面 | 全域切換：只譯文／原文＋譯文／加振り仮名／只日文 | hover 頁面 Balloon → 頁面上出 tooltip（原文＋ルビ＋譯文） | 底部 footer |
| **C 一次一個** | 閃卡：大裁圖＋大字原文，上方編號列跳轉，「對話／框外文字」兩個分頁 | 先看日文 → 點／空白鍵顯示讀音 → 再顯示譯文（先猜再看） | 點頁面 Balloon 跳到那張卡；`J`/`K` 換卡 | 精簡 icon 列＋展開 sheet |

讀音一律標成「推測」（A/C 用徽章，B 用說明列）。振り仮名是把 LLM 回的**整句假名**用「漢字段／假名段」正規表示式對齊回每個漢字（`alignRuby`），對不上才退回整句。

## 資料

`data.js` 由 `build-data.mjs` 產生，來源是 branch `prototype/claude55-api-compare` 的 `results/haiku-text/`（預設流水線「本機 OCR＋Haiku 5.5 文字模式」的實際輸出），所以 `本気` 會被讀成 `ほんき`、大型狀聲詞會漏抓，都是真實情況。p08 沒有這組輸出，所以沒收。
