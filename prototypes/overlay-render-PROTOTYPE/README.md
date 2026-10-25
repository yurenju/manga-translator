# PROTOTYPE：原地覆蓋的渲染方式（#19）

Throwaway，不會 merge。回答的問題：覆蓋層**掛在哪裡**、怎麼**跟著捲動／縮放／翻頁**；譯文**太長**時怎麼辦。

擦除（只擦 `textBbox`、底色從原圖取樣）、直書（`vertical-rl`＋全形標點）、量測縮字、Noto Sans TC 都沿用 #21 的結論，三個變體共用，只差「掛在哪、怎麼跟」。

## 跑起來

在 repo 根目錄：

```bash
python -m http.server 8722
```

開 <http://localhost:8722/prototypes/overlay-render-PROTOTYPE/index.html?variant=A&host=jumpplus>

- 底部黃框浮動列或 `←` `→` 切換變體；右上黃色控制台切換主頁面、譯文加長、顯示排版框、模擬主頁面重繪。
- 翻頁：點頁面左半＝下一頁、右半＝上一頁，或 `[` `]`。按住 `Shift` 看原文。Kindle 模擬可以按 ＋ 放大後拖曳。

## 兩個模擬主頁面

| | 結構 | 會動的方式 |
|---|---|---|
| **Jump+**（`host=jumpplus`） | 每頁一個 `<canvas>`，放在 `overflow:hidden` 的 viewer 裡，橫向排成一列 | 翻頁＝整列 `transform: translateX` 450ms 動畫；整頁可以上下捲動；header `sticky` |
| **Kindle**（`host=kindle`） | 整個可視區合成一張 `<img>`（雙頁＋黑邊），Page 用 `subRect` 指出位置 | 翻頁／resize＝換 `src`；縮放＝外層 `transform: scale` 250ms 動畫；放大後拖曳 |

## 三個變體

| | 掛在哪 | 怎麼跟 | 預期弱點 |
|---|---|---|---|
| **A 頂層層＋rAF** | `<html>` 下一個 `position:fixed` 的 shadow host，跟主頁面 DOM 完全分開 | 每一幀讀 anchor 的 `getBoundingClientRect()` 重設 transform；自己算 `overflow:hidden` 祖先做 `clip-path` | 永遠慢一幀（快速捲動時可能抖）；每幀都在跑；裁切要自己算 |
| **B 插在 anchor 旁邊** | anchor 的下一個兄弟節點（shadow host，`position:absolute`） | 用 `offsetLeft/Width` 定位一次，之後跟主頁面一起被捲動／transform／裁切；只在 anchor 尺寸變（ResizeObserver）或 DOM 變動時重算 | 會被主頁面框架重繪丟掉（要 MutationObserver 重掛）；父元素若是 `static` 要改成 `relative`；z-index 受主頁面 stacking context 影響 |
| **C 頂層層＋事件** | 同 A | 只在 scroll／resize／ResizeObserver／`transitionend`／style 變動時重算 | CSS 動畫進行中沒有事件 → 翻頁、縮放動畫期間停在舊位置，動畫結束才跳過去 |

控制台的「偏移」是每一幀**一開始**量到的「覆蓋層 vs anchor 應在位置」差距（＝使用者那一幀看到的偏移）。合成器執行緒的捲動（快速滑觸控板）量不到，要用眼睛看。

## 譯文太長（三個變體共用）

單位是 Page 原始像素（880×1280），整層再 `scale` 到畫面大小，所以縮字只量一次、縮放時不用重排：

1. 文字框外擴範圍內，從 26px 縮到 14px（藍框）
2. 還放不下 → 範圍擴到 Balloon 外框往內 10%，再縮到 12px（橘框）
3. 還放不下 → 10px 並截斷，滑過出 tooltip 顯示全文（紅虛線）

覆蓋層一律 `pointer-events: none`（不擋主頁面的點擊翻頁），滑過用座標自己 hit-test。

## 資料

`data.js` 複製自 `prototype/sidepanel-ui`（Haiku 5.5 文字模式的實際輸出）。
