# 大部分瀏覽器測試重播錄好的 OCR 結果，只留少數 e2e 跑真模型

原本 68 個 Playwright 測試全部載入真的 ONNX 模型、用 wasm 跑偵測與 OCR，LLM 才用 FakeTranslator 代替。16 核的機器上跑完要 3.6 分鐘，加總約 23 分鐘的測試時間，大多數測試單獨就要 30–40 秒，而且第一次量就有一個測試逾時失敗。8 個瀏覽器同時跑 OCR、互搶 CPU，讓等譯文出現的步驟偶爾超過時限。implement-spec 平行實作時，每個 ticket session 和合併時都各跑一次，慢和不穩都被放大。

但這些測試大多在測 OCR **之後**的事：覆蓋層、翻頁、快取、Series Notes、side panel。OCR 模型本身的品質只有 `ocr-accuracy` 在量。

## 決定

- **測試分層。** browser test：真的瀏覽器、真的外掛，OCR 與 LLM 都是假的，每次改動都跑。e2e：少數主要流程，OCR 是真的、LLM 是假的，需要時才跑（開整合 PR 前、改到 `src/offscreen/` 時）。smoke：呼叫真的 Claude API。分法與指令見 `docs/agents/testing.md`。
- **假 OCR 切在 `Engine`（`detect`／`recognize`）。** 分組、閱讀順序、座標換算、擦除底色仍是真的程式。很多 browser test 在驗證「譯文落在 Balloon 內」，等於在測座標換算，切在整個 `analyze` 會讓它們失去意義。
- **FakeEngine 重播真模型錄下來的結果，不是 ground truth。** `npm run record:ocr` 用真模型跑每張合成頁（Spread 再加上切開的每一頁），存成 `testdata/synthetic/recorded-ocr.json`；FakeEngine 把錄到的框換回偵測結果、用框對回錄到的字。
- **FakeEngine 用縮圖比對認出是哪個錄製範圍。** 外掛送進 `Engine` 之前已經去掉黑邊、把 Spread 切成兩頁，拿到的圖就是某個範圍縮放後的樣子；白底的仿 Kindle 不去邊，就照等比例縮放置中去比。最小的差異仍超過門檻就 throw，讓測試明確失敗，不會默默給錯的答案。
- **e2e 只留主要流程：** OCR 指標、模型下載與 SHA-256 檢查、仿 Jump+ 覆蓋、仿 Kindle Spread、翻頁後自動翻譯、仿 Kindle 工具列開關。它們標 `@e2e`，browser test 也用 FakeEngine 跑一次。

## 不直覺的地方

- **一開始用 ground truth 合成「完美的 OCR」，後來改成重播。** ground truth 的框比真模型小一圈，仿 Kindle 縮小 Spread 後，譯文用最小字級排在小框裡就超出 Balloon；真模型把 p02 的旁白框當成框外文字、p07 的卻當成 Balloon，沒有規則推得出來。原本的測試都是對著真模型的行為寫的，重播才對得上。代價是換模型時要重錄。
- **OCR 變快會暴露原本被蓋住的時序問題。** 仿 Kindle 的測試在 FakeEngine 不延遲時，右頁上方的譯文有時往上偏約一個工具列高（工具列開關的測試每次都會），每頁慢 3 秒就不會。真實網站上用 WebGPU 時 OCR 也可能很快，值得另外查；查清楚之前 `kindle.spec.ts` 用 `fakeOcrDelayMs` 以接近真 OCR 的速度跑。有些測試本來就假設 OCR 比翻頁、比畫面慢（佇列排程、逐字稿出來之前的版面），也用 `fakeOcrDelayMs` 明確寫出來。
- **browser test 不設 retry，e2e 設 1 次。** FakeEngine 是確定性的，browser test 出現 flaky 就代表程式本身有 race condition，應該直接紅；e2e 受機器負載影響，偶發逾時不值得擋住合併。e2e 一次只開一個瀏覽器，不互搶 CPU。

## 不採用的做法

- **用 ground truth 直接合成偵測框與文字。** 見上面：跟真模型的框大小、Balloon／框外文字的判斷都對不上。
- **在合成頁上畫頁碼記號來認頁。** 認頁最準，但測試圖會跟真實漫畫不一樣，而且每張圖都要重新產生。
- **由測試事先告訴 FakeEngine 下一頁是哪張。** 翻頁、快速連翻、Spread 這類測試裡，外掛分析的順序不是測試能事先決定的。
- **只降低平行數、繼續全部跑真模型。** 能減少 flaky，但每個測試仍要 30 秒以上，平行 session 的等待時間不會變短。
