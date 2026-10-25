# PROTOTYPE：本機 OCR 流水線（#7）

> **用完即丟的實驗程式，不是正式實作。** 只留在 `prototype/local-ocr-pipeline` branch，不 merge 進 main。
> 回答的問題：「用本機模型做文字偵測與 OCR，只把文字交給 Claude 翻譯，效果如何？」（[#7](https://github.com/yurenju/manga-translator/issues/7)）

## 流水線

```
Page 圖片
 → 偵測：comic-text-and-bubble-detector（detector-v4-s_int8，11 MB；分 bubble / text_bubble / text_free）
 → 分組：文字框歸到所在的 Balloon；沒有文字框的 Balloon 丟掉；Balloon 外的文字自成一組
 → 閱讀順序：從頁緣 flood fill 白色背景 → 剩下的連通區塊 = Panel → Panel bbox 做 XY-cut（上→下、右→左）→ Panel 內右→左
 → OCR：manga-ocr（onnx-community/manga-ocr-base-ONNX），自己寫 greedy decoding（沒有 KV cache）
 → 讀音：kuromoji（或請 Claude 順便給）
 → 翻譯：純文字 JSON 交給常駐的 claude -p --input-format stream-json（不送圖）
```

`core.mjs` 是共用核心；`ocr.mjs`（Node：onnxruntime-node，= 按需啟動的本機 server 路線）與
`browser.html`（Chrome：onnxruntime-web，= 外掛內路線）都用它。評分 `score.mjs` 從 #6 原樣複製，指標定義一致。

## 怎麼跑

```bash
cd prototypes/local-ocr-pipeline
npm install
npm run fetch-models          # 約 900 MB，下載到 models/
npm run bench -- m2           # 跑 CPU / WebGPU / CoreML 等組合並印分數，結果在 results/m2-*/
```

其他：

```bash
node ocr.mjs <run> --device webgpu [--det v4s|fp32] [--ocr-dtype fp32|q8] [--scale 0.5]
node translate.mjs <ocrRun> <newRun> [--model sonnet|haiku] [--reading claude] [--fresh]
node score.mjs <run>...        # 跟 #6 共用的指標
node score-extra.mjs <run>...  # 讀音（只比假名）、振り仮名命中、Balloon 內外分類、各階段延遲
npm run serve                  # 開 http://localhost:8787/browser.html?ep=webgpu&det=fp32 （Chrome）
```

## 結果（Windows：RTX 5090 Laptop、Claude 內建瀏覽器 Chromium 152 / Node 24，onnxruntime 1.30.0、7 張合成 Page，延遲為每頁 3 次中位數的平均）

### 本機 OCR（還沒翻譯）

| 組合 | 偵測 F1 | recall 全 | recall 覆蓋 | IoU | 順序 | 原文 | 讀音 | 每頁 s | 備註 |
|---|---|---|---|---|---|---|---|---|---|
| Node CPU fp32 | 89% | 87% | 100% | 0.79 | 98% | 97% | 90% | 2.65 | RSS 1.2 GB |
| Node CPU q8 | 89% | 87% | 100% | 0.79 | 98% | 98% | 91% | 2.03 | RSS 0.9 GB；模型 128 MB |
| Node WebGPU fp32 | 89% | 87% | 100% | 0.79 | 98% | 98% | 91% | 0.58 | |
| Node DirectML（det fp32）| 88% | 85% | 100% | 0.79 | 98% | 98% | 89% | 0.42 | DML 不支援 v4-s 的 int8 op |
| **Chrome WebGPU（det v4s）** | 88% | 86% | 100% | 0.80 | 98% | 98% | 91% | 0.97 | int8 detector 在 web 上偵測要 0.66 s |
| **Chrome WebGPU（det fp32）** | 87% | 86% | 100% | 0.80 | 98% | 97% | 87% | **0.42** | |
| **Chrome wasm（CPU）q8** | 89% | 86% | 100% | 0.80 | 98% | 98% | 91% | 1.95 | 沒 WebGPU 時的退路 |
| Node WebGPU，縮 0.75× | 88% | 84% | 98% | 0.79 | 98% | 98% | 91% | 0.57 | 模擬 captureVisibleTab 低解析度 |
| Node WebGPU，縮 0.5× | 87% | 82% | 98% | 0.80 | 98% | 95% | 88% | 0.56 | 440×640 |

- WebGPU 上 q8 反而變慢（3.4 s），GPU 用 fp32、CPU 用 q8。fp16 的 decoder ONNX 本身型別錯誤載不起來。
- 冷啟動（載入模型）：Node 約 1.4–2.5 s，Chrome 約 3–4 s（每次開外掛 / server 一次）。

### 加上 Claude 翻譯（OCR = Node WebGPU fp32）

| 組合 | 原文 | 讀音 | 譯文 chrF | 每頁 s（本機＋turn）| turn s | in tok | out tok | $（list 價）|
|---|---|---|---|---|---|---|---|---|
| Sonnet 常駐 | 98% | 91% | 73 | **2.6** | 2.0 | 3,949 | 220 | 0.022 |
| Sonnet 每頁新開 | 98% | 91% | 73 | 3.7 | 3.1 | 1,820 | 221 | 0.005 |
| Sonnet 常駐＋Claude 給讀音 | 98% | 85%（只比假名 98%）| 71 | 3.4 | 2.9 | 5,012 | 329 | 0.031 |
| Haiku 常駐 | 98% | 91% | 70 | 4.3 | 3.7 | 4,267 | 458 | 0.002 |

- 常駐模式對話脈絡會累積：input tokens 從第 1 頁 1.9k 長到第 7 頁 6.0k。
- 「Claude 給讀音」的 85% 主要是它把 `！？…` 拿掉；只比假名時 98%（kuromoji 94%）。

### 跟 #6「直接讓 Claude 看圖」比（#6 的 sonnet-cold：每頁新開）

| | 偵測 F1 | recall 覆蓋 | 順序 | 原文 | 讀音 | chrF | 每頁 s | out tok | $ |
|---|---|---|---|---|---|---|---|---|---|
| #6 Sonnet 看圖 | 100% | 100% | 94% | 99.8% | 99% | 74 | 6.3 | 711 | 0.017 |
| #7 本機 OCR＋Sonnet（每頁新開）| 89% | 100% | 98% | 98% | 91% | 73 | 3.7 | 221 | 0.005 |
| #7 本機 OCR＋Sonnet（常駐）| 89% | 100% | 98% | 98% | 91% | 73 | 2.6 | 220 | 0.022 |

## 看到的問題

- **大型描邊狀聲詞抓不到**（p04 的ドドドド、ガシャン、チリン）；detector 的 recall 缺口幾乎都在 sfx。map 已決定狀聲詞只在 side panel 顯示，影響有限。
- **p06 手機畫面**：detector 把訊息框成聊天泡泡（Balloon），GT 標成 `sign` 且只框文字，IoU < 0.3 被算漏抓；OCR 其實是對的（`textBbox` 對得很準）。
- **頁面上印的振り仮名會被 manga-ocr 忽略**，所以義訓（本気→マジ、相棒→パートナー）兩種讀音來源都會錯；要保留得另外 OCR ルビ。
- **kuromoji 的錯**：多音字（開いてる→ひらいてる、七時→ななじ、黄昏時→たそがれじ）、數字（4月12日→4つき12にち）、英文（OK、BUS STOP）。
- **合成頁的圓臉**會被當成 Balloon（真實漫畫較少見），靠「沒有文字框就丟掉」過濾。
- 有框的旁白會被分成 Balloon（4/6）；旁白本來就要原地覆蓋，實際上無害。
