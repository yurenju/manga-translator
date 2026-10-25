# 跨平台的本機日文漫畫 OCR 與文字偵測選項

> Research ticket: [#3](https://github.com/yurenju/manga-translator/issues/3)（Map: [#1](https://github.com/yurenju/manga-translator/issues/1)）
> 調查日期：2026-10-25。只讀文件，沒有下載或執行大型模型；速度數字除了特別標註「官方」的以外，都是**推估**，要靠 spike 驗證。

## 問題

有哪些文字偵測（detection，找位置）與 OCR（recognition，認字）方案可以在本機跑，而且 **Windows（RTX 5090 Laptop）** 與 **MacBook Air M2 16GB** 兩邊都能用？只有 CUDA 能跑的方案不合格。另外也要看：是否支援直書（縦書き）、模型大小與記憶體、M2 上的速度、授權、能不能在瀏覽器裡跑。

## 結論（TL;DR）

1. **最可行的跨平台組合是「漫畫專用 detector + manga-ocr」，兩個都用 ONNX 跑。** 這也是開源漫畫翻譯器的主流做法（manga-image-translator、koharu、owocr 的 segmented mode）。
   - Detection：`ogkalu/comic-text-and-bubble-detector`（RT-DETR-v2，Apache-2.0，同時偵測 **Balloon** 與「Balloon 外文字」，int8 只有 44 MB）或 `comic-text-detector`（偵測 text block 加 mask，ONNX 版 95 MB；原 repo 是 GPL-3.0）。
   - Recognition：`manga-ocr`（Apache-2.0，原生支援直書、多行、含振り仮名的 Balloon）。`onnx-community/manga-ocr-base-ONNX` 已經是 transformers.js 格式，量化後 encoder 加 decoder 約 75–115 MB。
2. **這套可以完全在 Chrome 外掛裡跑**（transformers.js / ONNX Runtime Web，WebGPU 或 WASM），也能放進需要時才啟動的本機 Python server（ONNX Runtime 用 CUDA EP / CoreML EP / CPU）。同一份 ONNX 模型兩邊都能用，所以 Windows/Mac 差異只剩 execution provider。
3. **作業系統內建 OCR 不適合當主力**：Apple `VNRecognizeTextRequest` 在 revision 3 支援日文，但 Apple DTS 在論壇上建議直書要先自己轉成橫書；VisionKit Live Text（Sonoma 起）才有直書。Windows.Media.Ocr 的官方文件完全沒提直書。兩者 API 不一樣，外掛也碰不到，需要原生程式。
4. **Panel 偵測與閱讀順序**：Magi（v1/v2/v3）能做 Panel、文字、角色、說話者關聯、閱讀順序，但模型約 1.7–2 GB，授權是「僅限學術研究」，範例都用 `.cuda()`。只適合拿來參考，不適合當依賴。
5. **讀音（振り仮名）**：OCR 輸出的是純文字，讀音要靠形態素解析器另外產生。瀏覽器裡用 kuromoji.js（Apache-2.0，純 JS，但 2023 年後沒有更新），本機 server 用 Sudachi（sudachi.rs / SudachiPy，Apache-2.0）。漫畫原圖上的振り仮名通常不需要（也不建議）用 OCR 讀出來。

## 比較表

| 方案 | 類型 | 直書 | 模型大小 | M2 預估速度 | CUDA (5090) | 授權 | 瀏覽器內 |
|---|---|---|---|---|---|---|---|
| **manga-ocr** (kha-white) | 辨識 | ✅ 原生 | PyTorch 444 MB；ONNX fp32 約 460 MB，q8 約 117 MB，q4f16 約 74 MB | 推估每個 Balloon 0.1–0.5 s（CPU/WASM），一頁 10 個 Balloon 約 1–5 s | 推估每個 Balloon < 50 ms | Apache-2.0 | ✅ transformers.js（onnx-community 版） |
| manga-ocr-base-2025 (jzhang533) | 辨識 | ✅（推定，與原版同架構） | 約 30M params，121 MB | 應該比原版快 | — | Apache-2.0 | ONNX 版有（l0wgear，約 140 MB） |
| **comic-text-and-bubble-detector** (ogkalu) | 偵測（bubble / text_bubble / text_free） | ✅（框不受方向影響） | 42.9M params；ONNX fp32 169 MB、int8 44 MB、v4-s int8 11 MB | 推估 640px 每頁 0.3–1.5 s（CPU/WASM），WebGPU 更快 | 推估 < 30 ms | Apache-2.0 | ✅ ONNX Runtime Web（RT-DETR 的 op 支援度要驗證） |
| **comic-text-detector** (dmMaze) | 偵測（text block + line + mask） | ✅（給 manga-image-translator 用在日文漫畫） | ONNX 95 MB | 推估每頁 0.5–2 s（CPU） | 推估 < 50 ms | 原 repo GPL-3.0（mayocream 的 ONNX 版標 Apache-2.0，權利狀態不明） | 有可能（ONNX），未驗證 |
| PaddleOCR PP-OCRv5 | 偵測 + 辨識 | 官方說辨識有強化直書 | mobile det 4.7 MB + rec 16.5 MB；server det 88 MB + rec 84 MB | 官方（Xeon CPU）：mobile 每張 1.75 s、server 4.34 s | 官方（V100）：0.62–0.74 s/張 | Apache-2.0 | 可以（社群轉 ONNX，如 RapidOCR），不是漫畫專用 |
| PaddleOCR-VL | VLM OCR + layout | 推定可以 | 約 1.9 GB + layout 212 MB | 16GB M2 跑得動但慢 | 快 | Apache-2.0 | ❌ 太大 |
| meikiocr (rtr46) | 偵測 + 辨識（遊戲取向） | ❌（owocr 說不能處理直書） | det 10–42 MB | CPU 很快 | CUDA EP | Apache-2.0（det 模型 LGPL-3.0） | 理論上可以（ONNX） |
| Apple Vision `VNRecognizeTextRequest` | 偵測 + 辨識 | ⚠️ 需要預處理 | 系統內建 | 快（Neural Engine） | N/A | 系統 API | ❌（要原生 helper） |
| Apple VisionKit Live Text (`ImageAnalyzer`) | 偵測 + 辨識 | ✅（Sonoma 起，依 owocr 與論壇） | 系統內建 | 快 | N/A | 系統 API | ❌ |
| Windows.Media.Ocr (WinRT) | 偵測 + 辨識 | ❓ 文件沒提 | 系統語言包 | N/A | 快（CPU） | 系統 API | ❌ |
| Windows OneOCR（Snipping Tool 內部） | 偵測 + 辨識 | 未驗證 | 系統內建 | N/A | 快 | 非公開 API | ❌ |
| Chrome Screen AI | 偵測 + 辨識 | 未驗證 | component updater 下發 | 快 | 快 | 非公開 | ❌ 沒有 extension API |
| **Magi v1/v2/v3** | Panel + 文字 + 角色 + 關聯 + OCR + 閱讀順序 | ✅ | 1.7–2.1 GB | 推估每頁數秒到十幾秒（MPS/CPU） | 快 | **僅限學術研究** | ❌ |
| koharu layout (RF-DETR seg) / yolo26s | 偵測 + segmentation | ✅ | 40M / 11.5M params | 推估快 | 快 | 要逐一確認 model card | 可能 |

> 「推估」是依模型大小與同類模型的經驗推算，**沒有實測**。M2 上的實際數字要等 [#7] 或後續 spike 量測。

## 各方案細節

### 1. manga-ocr（辨識）

- 來源：<https://github.com/kha-white/manga-ocr>、<https://huggingface.co/kha-white/manga-ocr-base>
- Vision Encoder Decoder（Transformers）。README 寫明支援直書與橫書、能一次讀多行文字，所以可以把整個 Balloon 丟進去，不用先切成行；也提到文字越長越容易出錯，失敗時可以切小一點再試。
- **只做辨識，不做偵測**：必須先由 detector 切出 Balloon 或文字區塊。
- 權重 `pytorch_model.bin` 444 MB；Apache-2.0。GPU 不是必要的。
- 瀏覽器版：<https://huggingface.co/onnx-community/manga-ocr-base-ONNX>，標了 `transformers.js`，有 fp32/fp16/int8/q4/q4f16 等版本（encoder fp32 343 MB、q4f16 50 MB；decoder fp32 117 MB、q4f16 24 MB）。
- 較新的變體 <https://huggingface.co/jzhang533/manga-ocr-base-2025>（約 30.3M params，121 MB，Apache-2.0），ONNX 版 <https://huggingface.co/l0wgear/manga-ocr-2025-onnx>（encoder 22 MB + decoder 118 MB，model card 自稱對直書、橫書、振り仮名、低畫質都穩定，但**沒有數據**，也沒標授權）。
- 對學日文的需求：manga-ocr 讀的是本文，振り仮名通常會被忽略或混進結果，品質要實測。讀音建議由形態素解析產生（見第 8 節）。

### 2. 文字與 Balloon 偵測

**ogkalu/comic-text-and-bubble-detector** — <https://huggingface.co/ogkalu/comic-text-and-bubble-detector>
- RT-DETR-v2（r50vd），約 42.9M params，Apache-2.0。
- 三個類別：`bubble`、`text_bubble`（Balloon 內文字）、`text_free`（Balloon 外文字，例如旁白、狀聲詞）。**這剛好對上 Map 的需求**：Balloon 原地覆蓋，以及對話框外文字要偵測。
- 訓練資料約 11k 張，涵蓋漫畫、webtoon、manhua、美漫；640 解析度。
- 有 `detector.onnx`（169 MB）、`detector_int8.onnx`（44 MB）、`detector-v4-s_int8.onnx`（11 MB）。

**comic-text-detector** — <https://github.com/dmMaze/comic-text-detector>
- 輸出 text block 的 bounding box、text line 與 segmentation mask（mask 之後做 inpainting 或白底遮蓋很有用）。block detector 是 YOLOv5。
- 原 repo GPL-3.0，2023 年後沒有更新。manga-image-translator（`ctd`）與 owocr 的 manga-ocr segmented mode 都用它。
- ONNX 版：<https://huggingface.co/mayocream/comic-text-detector-onnx>（95 MB，標 Apache-2.0，但它是從 GPL 專案轉來的，授權有疑慮；個人工具影響不大）。

**其他**
- `kitsumed/yolov8m_seg-speech-bubble`：只做 Balloon segmentation，GPL-3.0，ONNX 109 MB。
- koharu 作者的模型：<https://huggingface.co/mayocream>（`koharu-layout-rfdetr-seg-2xl-1152` 40.3M、`comic-layout-yolo26s` 11.5M、`manga109-segmentation-bubble` 等），授權要逐一看 model card。

### 3. PaddleOCR（PP-OCRv5 / PaddleOCR-VL）

- 來源：<https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html>、<https://github.com/PaddlePaddle/PaddleOCR>（Apache-2.0）
- PP-OCRv5 單一模型涵蓋簡中、繁中、英文、日文、拼音；官方說辨識有強化直書、手寫、藝術字等難例。
- 官方速度（V100 GPU / Xeon Gold 6271C CPU，200 張，含讀檔）：GPU mobile 0.62 s/張、server 0.74 s/張；CPU mobile 1.75 s/張、server 4.34 s/張。
- 權重（HF）：mobile det 4.7 MB、mobile rec 16.5 MB；server det 88 MB、server rec 84 MB。
- 缺點：不是漫畫專用，不會給出 Balloon 層級的分組；manga-image-translator 雖然有 `paddle` detector，但日文預設還是用自家 OCR。PaddleOCR-VL（約 1.9 GB）是 koharu 的 OCR 選項之一，16GB M2 上太重。

### 4. 作業系統內建 OCR

**Apple Vision**
- `VNRecognizeTextRequest` revision 3（WWDC22，macOS 13）加入日文。
- Apple DTS 在論壇（<https://developer.apple.com/forums/thread/772972>）回答直書問題時，建議先把每一行旋轉成橫書再辨識，並指出新的 `RecognizeTextRequest` 才支援 orientation 參數。另一篇中文直書討論（<https://developer.apple.com/forums/thread/749234>）回報 VNRecognizeTextRequest 處理直書不佳，VisionKit `ImageAnalyzer` 比較好。
- VisionKit Live Text（`ImageAnalyzer`，macOS 13+）：owocr README 寫「Sonoma 加入直書讀取」，owocr 也把它列為 macOS 推薦引擎。
- 要寫 Swift helper，外掛不能直接呼叫；只有 Mac 能用，Windows 那邊還是要另一套。

**Windows.Media.Ocr**
- <https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine>：輸出 Lines → Words，有 `MaxImageDimension`，語言靠系統語言包。官方文件**沒有任何直書相關說明**，OcrLine 也沒有方向屬性。
- Windows 11 Snipping Tool 內部的 OneOCR 被 owocr 列為推薦引擎，但那是非公開 API。

**Chrome Screen AI**
- Chromium 內建的裝置端 OCR（<https://chromium.googlesource.com/chromium/src/+/refs/tags/141.0.7390.65/services/screen_ai/README.md>），由 component updater 下發。owocr 作者認為它「可能是目前最好的本機引擎」，但**沒有提供給 extension 的公開 API**，只能透過非官方方式載入 DLL。

結論：內建 OCR 兩個平台的 API、輸出格式、直書行為都不一樣，而且都需要原生程式。可以當成「漫畫專用 OCR 之外的 fallback」或 spike 對照組，但不適合當主路徑。

### 5. 在瀏覽器內推論（ONNX Runtime Web / transformers.js）

- ONNX Runtime Web 的 execution provider：`wasm`（CPU，支援所有 op）、`webgpu`、`webnn`、`webgl`（GPU 類只支援部分 op）— <https://onnxruntime.ai/docs/tutorials/web/>。
- transformers.js 用 `device: 'webgpu'` 開啟 WebGPU，底層就是 ORT Web — <https://huggingface.co/docs/transformers.js/guides/webgpu>。Chrome 在 Windows/macOS 都支援 WebGPU，所以 RTX 5090 與 M2 GPU 都用得到，不需要 CUDA。
- Chrome 124 開始支援在 service worker 裡用 WebGPU（<https://developer.chrome.com/blog/new-in-webgpu-124>）；更早的做法是放在 offscreen document（<https://developer.chrome.com/docs/extensions/reference/offscreen>）。transformers.js 有官方 extension 範例（<https://github.com/huggingface/transformers.js/tree/main/examples/extension>）。
- 要注意：模型第一次要下載（manga-ocr q8 約 117 MB，加上 detector 44 MB），之後放 Cache Storage；RT-DETR 類模型在 WebGPU EP 上可能遇到不支援的 op，會退回 WASM，要實測。

### 6. Panel 與閱讀順序：Magi

- <https://github.com/ragavsachdeva/magi>：v1 偵測角色、文字、Panel 並做關聯；v2 加上角色名稱比對與整章說話者關聯；v3 加上 caption grounding。都提供 `predict_ocr`。
- 權重：`magi` 2.06 GB、`magiv2` 2.06 GB、`magiv3` 1.67 GB（HF）。
- 授權：模型與資料集**僅限學術研究**。範例用 `.cuda()`，v3 用 float16，demo 說沒 GPU 很慢。
- 定位：可以拿來研究「閱讀順序」怎麼做，但不適合當產品依賴。Map 已經說 Panel 偵測要不要做，取決於「直接讓 Claude 看圖」的實驗結果；如果 Claude 看整頁就能排出順序，就不需要 Magi。

### 7. 現有開源漫畫翻譯器用的 pipeline

| 專案 | Detection | OCR | 執行環境 | 授權 |
|---|---|---|---|---|
| manga-image-translator (<https://github.com/zyddnys/manga-image-translator>) | `default`（DBNet 類）、`dbconvnext`、`ctd`、`craft`、`paddle` | 預設 `48px`（日文、韓文推薦）、`32px`、`48px_ctc`、`mocr`（manga-ocr） | PyTorch，`--use-gpu` 自動選 CUDA 或 MPS，也能純 CPU | GPL-3.0 |
| koharu (<https://github.com/mayocream/koharu>) | Koharu Layout RF-DETR Seg 2XL（文字區、Balloon、mask） | PaddleOCR-VL 1.6、Manga OCR、Baberu OCR、Hayai OCR | Rust；CUDA / ROCm / **Metal** / Vulkan / CPU；Windows、macOS、Linux 都有 | MIT 或 Apache-2.0 |
| owocr (<https://github.com/AuroraWright/owocr>) | manga-ocr segmented mode 用 comic-text-detector | Screen AI、OneOCR、Apple Live Text、meikiocr、manga-ocr 等 | Python | — |

共同模式：**漫畫專用 detector → 每個區塊做 OCR**。koharu 證明這套可以用 Metal 在 Apple silicon 上跑，而且它的 OCR 候選裡也有 manga-ocr。

### 8. 讀音（振り仮名）生成

| 工具 | 環境 | 授權 | 備註 |
|---|---|---|---|
| kuromoji.js (<https://github.com/takuyaa/kuromoji.js>) | 純 JS，瀏覽器可用 | Apache-2.0（repo 附 LICENSE-2.0.txt） | `tokenize()` 回傳 `reading`（片假名），要自己轉平假名；最後 push 是 2023-11 |
| Sudachi (<https://github.com/WorksApplications/sudachi.rs>) | Rust / Python（SudachiPy） | Apache-2.0 | 持續維護（2026-10）；適合放在本機 server |
| kagome (<https://github.com/ikawaha/kagome>) | Go，有 WASM 範例 | MIT | 替代方案 |
| cutlet (<https://github.com/polm/cutlet>) | Python | MIT | 產生羅馬字，不是假名 |

另一條路是請 Claude 在翻譯時順便輸出讀音。這樣不用多一個依賴，但會多花 token，而且專有名詞可能讀錯；形態素解析器則有字典可以查。建議 spike 比較兩者。

## 建議

- **主路徑**：`comic-text-and-bubble-detector`（int8 ONNX）偵測 Balloon 與 Balloon 外文字 → 裁切 → `manga-ocr`（ONNX）辨識 → kuromoji.js 或 Sudachi 產生讀音。
- **執行位置**：優先試**瀏覽器內**（transformers.js / ORT Web + WebGPU，在 offscreen document 或 service worker 裡跑），因為不需要 server，兩個平台行為一致。如果 WebGPU 的 op 支援或速度不夠，退到需要時才啟動的 Python server（ONNX Runtime：Windows 用 CUDA EP，Mac 用 CoreML EP 或 CPU），模型檔不用改。
- **要 spike 量測的事**（建議併進 [#7] 或另開 ticket）：M2 上 WASM 與 WebGPU 的每頁延遲；manga-ocr 對含振り仮名的 Balloon 的辨識品質；RT-DETR ONNX 在 WebGPU EP 能不能跑；跟「直接讓 Claude 看整頁」比較準確度與 Claude 用量。
- **不建議**：只靠 CUDA 的方案、Magi 當依賴（授權與大小）、作業系統內建 OCR 當主路徑（兩平台不一致、直書支援不明）。

## Sources

- manga-ocr：<https://github.com/kha-white/manga-ocr>、<https://huggingface.co/kha-white/manga-ocr-base>、<https://huggingface.co/onnx-community/manga-ocr-base-ONNX>、<https://huggingface.co/jzhang533/manga-ocr-base-2025>、<https://huggingface.co/l0wgear/manga-ocr-2025-onnx>
- Detector：<https://huggingface.co/ogkalu/comic-text-and-bubble-detector>、<https://github.com/dmMaze/comic-text-detector>、<https://huggingface.co/mayocream/comic-text-detector-onnx>、<https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble>、<https://huggingface.co/mayocream>
- PaddleOCR：<https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html>、<https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec>、<https://huggingface.co/PaddlePaddle/PaddleOCR-VL>
- meikiocr：<https://github.com/rtr46/meikiocr>、<https://huggingface.co/rtr46/meiki.text.detect.v0>
- Apple：<https://developer.apple.com/documentation/vision/vnrecognizetextrequest>、<https://developer.apple.com/forums/thread/772972>、<https://developer.apple.com/forums/thread/749234>、<https://developer.apple.com/documentation/visionkit/imageanalyzer>
- Windows：<https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine>、<https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrline>
- Chrome：<https://chromium.googlesource.com/chromium/src/+/refs/tags/141.0.7390.65/services/screen_ai/README.md>、<https://developer.chrome.com/blog/new-in-webgpu-124>、<https://developer.chrome.com/docs/extensions/reference/offscreen>
- 瀏覽器推論：<https://onnxruntime.ai/docs/tutorials/web/>、<https://huggingface.co/docs/transformers.js/guides/webgpu>
- Magi：<https://github.com/ragavsachdeva/magi>
- 翻譯器：<https://github.com/zyddnys/manga-image-translator>、<https://github.com/mayocream/koharu>、<https://github.com/AuroraWright/owocr>
- 讀音：<https://github.com/takuyaa/kuromoji.js>、<https://github.com/WorksApplications/sudachi.rs>、<https://github.com/ikawaha/kagome>、<https://github.com/polm/cutlet>

[#7]: https://github.com/yurenju/manga-translator/issues/7
