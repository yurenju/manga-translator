# 翻譯與 Series Notes 分成兩次呼叫，翻譯帶 Prior Pages、不開 thinking

[ADR 0002](0002-series-notes-maintained-by-llm-in-indexeddb.md) 讓 LLM 在同一次翻譯呼叫裡順手回傳 `notes_changes`。在真實的 Jump+ 上量到，翻頁到譯文出現約 8.5 s，其中 LLM 約 6.6 s，大部分是 thinking：每頁 output 約 1100–1300 tokens，譯文本身只有幾百。直接關掉 thinking，LLM 時間就減半，但 Notes 變得很亂。另外，「Notes 依送出順序套用」讓 Spread 的第二頁就算先翻完，也要等第一頁 commit 完才顯示（[#49](https://github.com/yurenju/manga-translator/issues/49)）。

## 決定

- **① 翻譯呼叫：只回傳譯文，thinking 關，帶 Prior Pages。** Prior Pages 是這個分頁、這部 Series 裡，在目前這批之前最近看過的 2 頁，每句只送 `{kind, ja, zh}`，跳過 unreadable。前頁還沒翻完就不等，只帶已經翻好的。① 一回來就寫快取、顯示譯文；`usedNotes` 用 ① 送出時的 Notes 快照。
- **② Notes 呼叫：在背景、每頁一次、thinking 開。** 輸入這一頁的原文＋① 的譯文，只回傳 `notes_changes`；條目的譯名必須照抄譯文裡用的。「依送出順序套用」只管 ② 的結果。② 失敗就跳過，譯文不受影響，只記在 trace。
- **LLM 不再填自稱、語氣、稱呼。** OCR 只有文字、沒有發言者，只看文字會把這三個欄位補到錯的角色身上，而且補上之後就一直留著。欄位保留，只由人在 side panel 編輯。

在同一話 22 頁上離線重送比較：① 帶 Prior Pages 的延遲平均 3.5 s，現況是 6.3 s；需要前後文才能翻對的句子，只有這一組全部翻對。每頁費用從 $0.00065 降到約 $0.0004。

## 不直覺的地方

- **多一次呼叫，費用反而比較低。** 現況的 thinking 幾乎都花在翻譯上；拆開之後，翻譯不想，Notes 那一次也只產生約 80 tokens。
- **翻譯不需要 thinking，但需要上下文。** thinking 關掉造成的誤譯，多半是缺前後文（指代的對象、角色性別、要靠劇情才猜得出的詞），帶 Prior Pages 就補回來了。帶前頁增加的 input 約 1000 tokens，延遲幾乎不變，因為延遲主要取決於 output。
- **Prior Pages 依讀者看過的順序，不是話裡的頁序。** 我們沒有頁碼；跳頁或往回翻時，前頁就不是上一頁，這是可以接受的代價。
- **Notes 晚一點才更新。** 新名字第一次出現的那一頁，譯名靠 Prior Pages 維持一致；② 套用之後，再進 Series Notes 供之後的頁使用。

## 不採用的做法

- **每 N 頁批次整理 Notes。** 直覺上看得越多越準，但實驗結果是雜訊多很多（重複新增既有條目、把「人名＋敬稱」當新人名）；原因還在 [#64](https://github.com/yurenju/manga-translator/issues/64) 研究。
- **回頭訂正已讀頁面的譯文。** 讀者多半已經翻過去，看不到訂正；改到畫面上的頁反而干擾閱讀。
- **關 thinking，但保留同一次呼叫。** 能變快，但 Notes 的紀律明顯變差，而 Notes 會一直沿用到之後的每一頁。
