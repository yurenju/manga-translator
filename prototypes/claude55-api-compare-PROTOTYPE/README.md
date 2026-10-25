# PROTOTYPE：比較 Claude 5.5 系列 API 的翻譯品質、延遲與費用（#15）

用完即丟的實驗，**不 merge 進 main**。回答 issue #15，結論貼在 #15。

直接用原生 `fetch` 打 `POST https://api.anthropic.com/v1/messages`（跟 Chrome 外掛裡會寫的一樣），
不再經過 `claude -p`。評分沿用 #6 的 `score.mjs` / `notes-compliance.mjs`，數字可以直接跟 #6、#7 比。

```bash
# key 由 1Password CLI 在執行時注入，不落地
export OPREF=op://Private/manga-translator-claude-key/credential
ANTHROPIC_API_KEY=$OPREF op run -- node run.mjs <run> --model haiku|sonnet|opus --input image|text \
  [--effort low] [--thinking off] [--notes series-notes.md] [--cache] [ids...]
sh all.sh   # 整個實驗矩陣＋評分 → report.md（內部只呼叫一次 op read）
node score.mjs <run>...              # 對 testdata/synthetic 的 ground truth 自動評分
node notes-compliance.mjs <run>...   # Series Notes 指定譯名遵守率
```

- `--input image`：整頁 PNG（同 #6 的 prompt 與 schema），模型回傳 bbox／原文／讀音／順序／譯文。
- `--input text`：只送本機 OCR 的文字（`ocr-input/` 取自 #7 的 `webgpu-fp32` run），模型回傳讀音＋譯文。
- 設定：`output_config.effort = "low"`、`output_config.format = json_schema`（structured outputs）、`anthropic-version: 2026-10-21`、非串流。
- 延遲是單次 HTTP 請求的牆鐘時間（Windows 機器、家用網路）；text 模式的 wall 另外加上 #7 量到的本機 OCR 時間。
- 費用用 list price 從 `usage` 換算（Haiku 5.5 $0.10/$0.50、Sonnet 5.5 $2/$10、Opus 5.5 $4/$20 per MTok）。
- `results/` 是實驗原始資料（只有合成頁，可 commit）。
