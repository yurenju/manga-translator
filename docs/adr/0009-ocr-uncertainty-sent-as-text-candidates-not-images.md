# 不把圖片送給 LLM，OCR 的不確定性用文字候選字傳過去

真實網站第二輪盤點（[#123](https://github.com/yurenju/naruhodo-manga-translator/issues/123)）在正文對白看到 OCR 誤讀造成誤譯、而且譯文蓋上了頁面：半濁音讀成清音（プ→フ）、手寫小字整句讀成另一句通順的日文。只差一個字、讀起來不通的錯字，LLM 會靠上下文自己修回；修不回來的，是錯字本身看起來就像一句合理的日文，只看文字沒有任何線索。

最直接的修法是讓 LLM 看那個 Balloon 的 crop 圖、自己再讀一次。但隱私權政策、README、Web Store 上架文案、官網 FAQ 與外掛裡的資料流說明都承諾**圖片不會離開使用者的電腦，送出去的只有辨識出來的文字**，裁切過的小圖也一樣是圖片。

## 決定

- **任何情況都不把圖片（整頁或 crop）送給 LLM**，包括 Own API Key 與 Hosted Translation。
- **OCR 的不確定性用文字傳過去。** OCR 解碼時每一步本來就算出所有字的機率；信心低的字在送出的原文裡標出來，附上前幾名的候選字，讓 LLM 從候選裡挑出合乎語境的那一個。Balloon 與 Loose Text（含 Sound Effect）都一樣。
- **LLM 挑不出合理的句子就回 `unreadable`，不蓋上頁面**，讀者看到的是日文原文，而不是一句看起來通順的錯誤譯文。
- **翻譯呼叫回傳 LLM 修正後的原文**，Notes 呼叫與 Prior Pages 用修正後的版本，錯字不會被記進 Series Notes。

門檻與候選字數量由離線實驗決定（[#133](https://github.com/yurenju/naruhodo-manga-translator/issues/133) 開的子 ticket）。

## 不採用的做法

- **送 Balloon 的 crop 圖給 LLM。** 對手寫字與濁音、半濁音最有效，也能順便讓 LLM 看出角色性別，但違反「圖片不離開電腦」的承諾。要改承諾得先改所有對外文案，而且「只送文字」是外掛隱私定位的核心，不值得為少數誤讀放棄。
- **只在 prompt 裡要 LLM 懷疑不合語境的句子。** 修不回來的錯字恰好都合乎語境，LLM 沒有可以懷疑的依據。
- **換 OCR 模型。** manga-ocr 已經是開源漫畫 OCR 裡相對好的；換模型要重新驗證偵測、效能與重錄 FakeEngine 的資料（[ADR 0007](0007-browser-tests-fake-the-ocr-engine.md)），等候選字證明不夠再研究。
