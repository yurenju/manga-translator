# PROTOTYPE：直接讓 Claude 看圖翻譯整頁（#6）

用完即丟的實驗，**不 merge 進 main**。回答 issue #6 的問題，結論貼在 #6。

```bash
node run.mjs <runName> [--model sonnet|opus|haiku] [--scale 0.625] [--notes series-notes.md] [--resident] [ids...]
node score.mjs <runName>...           # 對 testdata/synthetic 的 ground truth 自動評分
node notes-compliance.mjs <runName>... # Series Notes 指定譯名遵守率
node viewer.mjs <runName>...          # 產生 viewer.html（GT 綠框 vs 預測紅框）
```

`--scale` 需要先在 `scaled/` 放好 `<id>@<scale>.png`（實驗時用 PowerShell System.Drawing 縮的）。
`results/` 是實驗原始資料（只有合成頁，可 commit）。
