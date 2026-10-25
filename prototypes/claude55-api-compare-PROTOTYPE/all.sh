#!/bin/sh
# PROTOTYPE（#15）：一支 script 跑完整個實驗＋評分。只呼叫一次 1Password CLI（只跳一次授權）。
#   sh all.sh            → 實驗原始資料寫到 results/，評分報表寫到 report.md
set -e
cd "$(dirname "$0")"
if [ -z "$ANTHROPIC_API_KEY" ]; then
  ANTHROPIC_API_KEY=$(op read "op://Private/manga-translator-claude-key/credential")
  export ANTHROPIC_API_KEY
fi

RUNS=""
run() { name=$1; shift; node run.mjs "$name" "$@"; RUNS="$RUNS $name"; }

for m in haiku sonnet opus; do
  for i in text image; do
    run $m-$i --model $m --input $i
    run $m-$i-notes --model $m --input $i --notes series-notes.md p02-ruby p04-outside p05-dense p06-horizontal
  done
done
for i in text image; do
  run haiku-$i-nothink --model haiku --input $i --thinking off
  run sonnet-$i-nothink --model sonnet --input $i --thinking off
done
# prompt cache：同一個 system（含 Series Notes）連打 7–8 頁
run sonnet-text-notes-cache --model sonnet --input text --notes series-notes.md --cache
run sonnet-image-notes-cache --model sonnet --input image --notes series-notes.md --cache

{
  echo "# 評分報表（$(date '+%Y-%m-%d %H:%M')）"
  node score.mjs $RUNS
  echo
  echo "## Series Notes 遵守率"
  node notes-compliance.mjs $(echo $RUNS | tr ' ' '\n' | grep notes)
} > report.md
echo "完成，報表在 report.md"
