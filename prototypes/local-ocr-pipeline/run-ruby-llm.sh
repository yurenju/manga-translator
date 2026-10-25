#!/bin/sh
# PROTOTYPE（#14）：跑完整個 LLM 比較矩陣＋評分 → results/ruby-llm-report.txt
# 只在開頭呼叫一次 op read（1Password 只會跳一次授權），之後各組共用同一個環境變數。
# llm.mjs 會跳過已經有結果的頁面，所以中斷後重跑這個 script 會接著跑。
#
# 用法：cd prototypes/local-ocr-pipeline && sh run-ruby-llm.sh
set -e
cd "$(dirname "$0")"
ANTHROPIC_API_KEY="$(op read op://Private/manga-translator-claude-key/credential)"
export ANTHROPIC_API_KEY

node llm.mjs ruby-v2 haiku-none --hints none --reps 3
node llm.mjs ruby-v2 haiku-ruby --hints ruby --reps 3
node llm.mjs ruby-v2 haiku-image-z1 --hints image --reps 3
node llm.mjs ruby-v2 haiku-image-z3 --hints image --zoom 3 --reps 3
node llm.mjs ruby-v2 sonnet-none --model sonnet --hints none
node llm.mjs ruby-v2 sonnet-ruby --model sonnet --hints ruby
node llm.mjs ruby-v2 sonnet-image-z3 --model sonnet --hints image --zoom 3

node score-ruby.mjs ruby-v2 ruby-v2-s0.75 ruby-v2-s0.5 \
  haiku-none haiku-ruby haiku-image-z1 haiku-image-z3 \
  sonnet-none sonnet-ruby sonnet-image-z3 | tee results/ruby-llm-report.txt
