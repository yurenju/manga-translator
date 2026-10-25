# Claude Code 能怎麼被外部程式呼叫

> Research ticket：[#2](https://github.com/yurenju/manga-translator/issues/2)（map：[#1](https://github.com/yurenju/manga-translator/issues/1)）
> 調查日期：2026-10-25，本機 Claude Code 版本 `2.1.310`（Windows 11）。
> 限制條件（取自 map）：Chrome MV3 外掛 + 本機 Claude Code；Windows 與 MacBook Air M2 都要能跑；本機 server 可以有但不常駐；必須用使用者的 Claude 訂閱（不用 API key）。

## TL;DR

- 使用者說的「socket message」最可能是 **cross-session messaging 的 inbox socket**（每個 session 一個 Unix domain socket / Windows named pipe，路徑在 `CLAUDE_CODE_MESSAGING_SOCKET`）。它的設計用途是「Claude Code session 之間互傳純文字」，外部 script 也能寫進去，但**只收純文字、沒有官方公開的 wire format、Windows 上需要 session 自己的 token**，不適合當我們的 API。另一個相近功能是 **Channels**（MCP server 把事件 push 進正在跑的 session），但目前是 research preview，自製 channel 要用 `--dangerously-load-development-channels`，且**在 `-p` / Agent SDK 下會被忽略**。
- **最適合本專案的路線是 `claude -p --input-format stream-json --output-format stream-json`（或包一層 Claude Agent SDK）**，由一個「需要時才啟動」的本機 bridge process 管理。它可以直接傳 base64 圖片、回傳結構化 JSON、用使用者的訂閱 OAuth 登入（實測 `apiKeySource: none`），Windows / macOS 都可以用。
- 實測（Windows，haiku，極簡設定）：冷啟動一次 `claude -p` ≈ 3.7–4.8 秒；預設設定 ≈ 6.9–7.3 秒；**保持同一個 stream-json process，第二次帶圖請求 ≈ 3.8 秒**。
- 條款：個人在自己的機器上用自己的訂閱跑**未修改的** Claude Code binary / Agent SDK 是被允許的（advertised limits 假設是「ordinary, individual usage of Claude Code and the Agent SDK」）。禁止的是把 claude.ai 登入做進第三方產品給別人用，或代收／轉介他人的訂閱憑證。我們的工具是個人用、不上架，符合這個界線，但**不要**自己去讀取或轉存 OAuth token。
- **`--bare` 不能用**：bare mode 只吃 `ANTHROPIC_API_KEY` / `apiKeyHelper`，不讀 OAuth。要提速只能用 `--tools`、`--strict-mcp-config`、`--setting-sources` 等旗標手動精簡。
- Chrome 外掛與本機 process 的橋接：**Native Messaging**（`chrome.runtime.connectNative`）可以讓 Chrome 按需啟動 bridge，符合「不常駐」；但 host→extension 單則訊息上限 1 MB，回傳大結果要切塊。或者 bridge 起 localhost HTTP server，讓外掛用 fetch 呼叫（但需要另外的啟動方式）。

## 候選方式總覽

| 方式 | 能否傳圖片 | 冷啟動 / 每次延遲 | 併發 | 用訂閱額度 | Windows / macOS | 條款或其他限制 |
| --- | --- | --- | --- | --- | --- | --- |
| **`claude -p` 單次呼叫** | 可以，但要靠 stream-json 輸入，或讓 Claude 用 Read tool 讀檔 | 每次都冷啟動：實測 3.7–7.3 秒（含模型回應） | 開多個 process 即可並行 | 是（OAuth；`--bare` 除外） | 都可以 | 無特別限制；個人使用 |
| **`claude -p` stream-json 常駐 process（bridge 內）** | 可以，base64 `image` content block（實測成功） | 第一次約 5 秒，之後每則約 3.8 秒（haiku、小圖） | 同一個 process 內的訊息會排隊依序處理；要並行就開多個 process | 是（實測 `apiKeySource: none`） | 都可以 | 同上 |
| **Claude Agent SDK（TS / Python）** | 可以（streaming input mode；single message mode 不行） | 跟 stream-json 相同（SDK 底層就是跑 Claude Code binary） | 同上 | 會用本機已登入的 OAuth；官方文件寫第三方產品要用 API key | 都可以 | 「Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login…」，個人自用不屬於這個情況 |
| **Channels（MCP push 進正在跑的 session）** | 只能傳字串；圖片要先存檔，再把路徑放進 `meta` 讓 Claude Read（fakechat 就是這樣做） | 不用冷啟動（session 已經在跑），但需要一個常駐的互動 session | 事件排隊，忙碌時會合併到下一輪；要並行就開多個 session | 是 | 都可以（channel 是 stdio MCP server） | Research preview；自製 channel 要用 `--dangerously-load-development-channels`，需要互動確認；`-p` / SDK 下會被忽略；沒有送達 ACK |
| **Cross-session messaging inbox socket**（使用者說的「socket message」） | 不行，只能傳純文字 | 不用冷啟動，但需要一個已經在跑的 session | 會排隊；有 rate limit 與 50 則上限 | 是 | 都可以（UDS / named pipe；Windows 需要 token） | wire format 只公開了 auth 那一行；外部程式送來的訊息會被當成「來自另一個 session」，不能核准權限，還可能被 hold |
| **MCP（Claude Code 連我們的 MCP server、反向拉工作）** | MCP tool 結果可以回圖片（MCP spec），或讓 Claude Read 檔案 | 需要有 Claude session 在跑並主動呼叫 tool；本身不會觸發 Claude 開始工作 | 由 session 數量決定 | 是 | 都可以 | 標準 MCP 是 pull model，「nothing is pushed to the session」。適合當 Series Notes 之類的工具，不適合當觸發機制 |
| **Remote Control** | 可以（從 claude.ai / 手機 App 附圖） | — | — | 是（需要 claude.ai 登入） | 都可以 | 給人類從 claude.ai/code 或手機操作，**沒有公開的程式 API** |
| **Chrome Native Messaging**（外掛 → 本機 process 的傳輸層，不是 Claude Code 功能） | JSON 訊息，extension→host 上限 64 MiB、host→extension 上限 1 MB | `connectNative` 會啟動 host，port 關掉後 host 就結束 | 一個 port 一個 process | 不相關（host 再去呼叫 `claude`） | 都可以（Windows 用 registry 指向 manifest；macOS 放在 `NativeMessagingHosts/`） | 需要額外安裝 host manifest |

## 1. 「socket message」到底是什麼

Claude Code 文件索引裡沒有任何頁面以 "socket" 為標題，但有兩個功能符合「外部送訊息進 session」的描述：

### 1a. Cross-session messaging 的 inbox socket（最可能）

- 每個啟用 cross-session messaging 的 session 都會綁一個 inbox socket：「The socket is a Unix domain socket on macOS and Linux, including Linux inside WSL 2, and a named pipe on native Windows.」路徑在 `/status` 的 `Peer address` 列，並以 `CLAUDE_CODE_MESSAGING_SOCKET` 匯出給 hooks 與 Bash。[cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging.md#the-sessions-inbox-socket)
- 版本需求：macOS / Linux 要 v2.1.224+，native Windows 要 v2.1.234+。[同上](https://code.claude.com/docs/en/cross-session-messaging.md)
- Script 可以寫入：文件明確提到「when you want a script or hook to post into a session」。第一行可以送 `{"type":"auth","token":"<token>"}`（token 來自 `CLAUDE_CODE_MESSAGING_TOKEN`）。**native Windows 上這行是必要的**，否則連線會被關掉；而且 30 秒內沒送出完整一行也會被關掉。[同上](https://code.claude.com/docs/en/cross-session-messaging.md#the-sessions-inbox-socket)、[env-vars](https://code.claude.com/docs/en/env-vars.md)
- 限制：
  - 「Plain text only」，不能傳圖片。[Limitations](https://code.claude.com/docs/en/cross-session-messaging.md#limitations)
  - 收件方會把它當成「來自另一個 session」的訊息，不能核准權限，也不能改設定。
  - 依兩邊的 permission mode，訊息可能被 hold 等人工核准（`-p` session 預設 5 分鐘後丟棄）。
  - 有 rate limit，最多排 50 則。
  - 文件只公開了 auth 那一行，**訊息本體的 JSON 欄位沒有文件**，屬於內部協定，隨時可能改。
  - token 是 per-session，只匯出給該 session 自己的子程序，外部的外掛 bridge 拿不到（Windows 上就無法通過驗證）。
- `claude -p` 也會綁 socket；`--bare` 則不會。[Non-interactive sessions](https://code.claude.com/docs/en/cross-session-messaging.md#non-interactive-sessions)
- **結論**：可以把通知塞進一個已經在跑的 session，但只能傳純文字、協定沒有公開、Windows 需要 token，不適合當翻譯 API。

### 1b. Channels（第二可能）

- 「A channel is an MCP server that pushes events into your running Claude Code session」，可以是雙向的（channel 提供 `reply` tool）。[channels](https://code.claude.com/docs/en/channels.md)
- 機制：channel 是 Claude Code 以 stdio 啟動的 MCP server，宣告 `capabilities.experimental['claude/channel']`，再送 `notifications/claude/channel`（`content: string`、`meta: Record<string,string>`）。官方範例就是「local HTTP port → push 給 Claude」的 webhook receiver。[channels-reference](https://code.claude.com/docs/en/channels-reference.md)
- 圖片：`content` 只能是字串。fakechat 的做法是把上傳的檔案存到 `~/.claude/channels/fakechat/inbox`，再把 `file_path` 放進 `meta`，instructions 寫「If the tag has a file_path attribute, Read that file」。[fakechat server.ts](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat)
- 限制：
  - Research preview，`--channels` 只接受 allowlist 上的 plugin，自製 channel 要用 `--dangerously-load-development-channels`，而且要在互動 session 裡點確認。「If you pass it in non-interactive mode with `-p` or through the Agent SDK, Claude Code ignores the flag and the channel doesn't register.」[Test during the research preview](https://code.claude.com/docs/en/channels-reference.md#test-during-the-research-preview)
  - 沒有 ACK：「Claude Code doesn't acknowledge notifications.」事件會排隊，忙碌時合併處理；「To process independent event streams concurrently, run separate sessions.」[Notification format](https://code.claude.com/docs/en/channels-reference.md#notification-format)
  - 回覆走 reply tool，會觸發權限提示（可用 permission relay 或 allow 規則處理）。
  - 需要 claude.ai 或 Console 認證；Pro / Max 個人帳號不受 org 開關限制。[Enterprise controls](https://code.claude.com/docs/en/channels.md#enterprise-controls)
- **結論**：channels 是「把外部事件推進使用者正開著的互動 session」的正規做法。但它需要一個常駐的互動 terminal，加上 dev flag 確認畫面，回傳路徑也要自己做（reply tool → SSE），跟「不常駐、按需啟動」相衝突。可以當成之後「在 Claude Code 對話裡同時討論翻譯」的加分選項，不建議當主路徑。

## 2. `claude -p` headless

文件：[headless](https://code.claude.com/docs/en/headless.md)、[cli-reference](https://code.claude.com/docs/en/cli-reference.md)

- **輸出格式**：`--output-format text | json | stream-json`。`json` 含 `result`、`session_id`、`usage`、`total_cost_usd`（client 端估算）。可以加 `--json-schema` 拿到 `structured_output`，很適合拿來產生 Balloon 陣列（原文、讀音、譯文）。
- **輸入格式**：`--input-format text | stream-json`。stream-json 每行一個 `{"type":"user","message":{"role":"user","content":[...]}}`，content 可放 `{"type":"image","source":{"type":"base64","media_type":"image/png","data":...}}`。這跟 Agent SDK streaming input 是同一個格式。[streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md)
- **圖片的另一種傳法**：存成檔案，在 prompt 裡叫 Claude 用 Read tool 讀（要允許 `Read`）。這會多一輪 tool call，比較慢。
- **Session 延續**：`--continue`、`--resume <session_id 或 .jsonl 路徑>`、`--session-id <uuid>`、`--fork-session`。不需要的話用 `--no-session-persistence`。
- **`--bare`**：「Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your subscription login」，而且也不讀 `CLAUDE_CODE_OAUTH_TOKEN`。**本專案不能用**。替代的精簡做法：`--tools ""`（或只開 `Read`）、`--strict-mcp-config`、`--setting-sources ""`、`--disable-slash-commands`、`--model`。
- **權限**：v2.1.302 起 `-p` 預設是 Manual mode，需要核准的 tool 呼叫會被拒絕。純翻譯任務不需要 tool，`--tools ""` 最乾淨。
- **stdin 上限**：piped stdin 最多 10 MB。
- **注意**：沒有 `--bare` 的 `-p` 會載入 cwd 的 `.claude/settings.json` hooks 與 `.mcp.json`，而且**不會出現 trust 對話框**。bridge 應該在固定、乾淨的工作目錄下執行，並搭配 `--setting-sources` / `--strict-mcp-config`。

### 本機實測（Windows 11、Claude Code 2.1.310、訂閱登入、`--model haiku`）

| 情境 | 結果 |
| --- | --- |
| `claude -p "reply with just: hi" --output-format json`（預設載入所有設定） | 6.9 s / 7.3 s；cache_creation 約 42k tokens（系統提示、tools、skills、plugins） |
| 同上，加 `--tools "" --strict-mcp-config --disable-slash-commands --setting-sources ""` | 3.7 s / 4.8 s；cache_creation 約 3.6k tokens |
| 常駐 stream-json process，送兩則「300×120 PNG（こんにちは）+ 指令」 | `init` 在 spawn 後 0.7 s 出現；第一則 5.1 s、第二則 3.8 s；正確辨識「こんにちは」並給出讀音與「你好」；`apiKeySource: none`（代表用的是 OAuth 訂閱） |

結論：**每次呼叫的固定開銷約 1–3 秒，常駐 process 可以省掉這段**；精簡 context 能省下大約 10 倍的 input token（也就是訂閱額度）。真實漫畫 Page 的延遲要等 OCR / vision 的 spike 再量。

## 3. Claude Agent SDK（TypeScript / Python）

- 「A library that runs the Claude Code binary」，Claude Code 的能力（tools、permissions、sessions、hooks、MCP）都可以用。[agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview.md)
- 圖片：streaming input mode 支援「Image uploads」；single message input「does **not** support: Direct image attachments in messages」。[streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md)
- 認證：SDK 跟 CLI 用同一套憑證優先順序，最後一順位是「Subscription OAuth credentials from `/login`」。也就是說，只要沒有設定 `ANTHROPIC_API_KEY`，就會用使用者已登入的訂閱。`CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` 產生、效期一年）是「Alternative to `/login` for SDK and automated environments」。[authentication](https://code.claude.com/docs/en/authentication.md#authentication-precedence)、[env-vars](https://code.claude.com/docs/en/env-vars.md)
- 條款（重點）：
  - 「Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.」[agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview.md)
  - 「Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.」[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance.md#acceptable-use)
  - 「Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens」；但也寫到不禁止「an end user from signing in to the unmodified Claude Code binary with their own Claude subscription」。[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance.md#authentication-and-credential-use)
  - 解讀：本專案是**使用者自己寫、自己用**的工具，跑未修改的 Claude Code，用的是自己 `/login` 的訂閱，沒有其他使用者，屬於「individual usage」。這個界線要守住：不上架、不代別人登入、bridge 不讀取或轉存 OAuth token（讓 Claude Code 自己處理）。如果之後要分發給別人，就必須改用 API key，但這已經在 map 的 out of scope 裡。
- 跟直接 spawn `claude -p` 比：SDK 多了 typed message、`canUseTool` callback、`interrupt()`、session 管理。bridge 用 Node 寫的話，SDK 是比較省事的包裝；用其他語言就直接 spawn CLI。兩者延遲相同。

## 4. MCP（Claude Code 連到我們的 MCP server）

- 標準 MCP 是 pull model：「Claude queries it during a task; nothing is pushed to the session」。[channels 比較表](https://code.claude.com/docs/en/channels.md#how-channels-compare)
- 用途：讓 Claude 在翻譯時呼叫我們的 tool，例如讀寫 Series Notes、取得下一張待翻 Page。可以透過 `--mcp-config` 傳給 `-p` / SDK（有 `MCP_TIMEOUT` 啟動等待，預設 30 秒）。
- 「反向拉工作」（session 不停呼叫 `get_next_job`）需要一個持續運作的 session 自己去 poll，會浪費 turn 和額度，也一樣需要常駐。**不建議當觸發機制**；建議把它當成 Series Notes 的存取介面（跟 map 提到「Claude Code 也能直接讀寫 Series Notes」相呼應）。
- Agent SDK 另外支援 in-process 的 custom tools（SDK MCP server），bridge 可以直接把 Series Notes 的讀寫做成 tool。[agent-sdk/custom-tools](https://code.claude.com/docs/en/agent-sdk/custom-tools.md)

## 5. Chrome Native Messaging（外掛 → 本機 bridge 的傳輸層）

文件：[Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

- `connectNative()`：Chrome 啟動 host process，「keeps it running until the port is destroyed」。`sendNativeMessage()`：「Chrome starts a new native messaging host process for each message」。
- 走 stdin / stdout，每則訊息是 UTF-8 JSON，前面加 32-bit 長度前綴（native byte order）。
- 大小：host→extension 單則最多 1 MB，extension→host 最多 64 MiB。截圖往 host 送沒問題；翻譯結果通常遠小於 1 MB，但要有分塊機制當保險。
- 註冊：Windows 在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>` 的預設值寫入 manifest 路徑；macOS 放在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`。兩個平台都支援。
- 只能在 extension pages / service worker 裡用，content script 不行。
- 符合「不常駐、需要時才啟動」：外掛開始翻譯時 `connectNative`，host 再 spawn 一個 `claude -p` stream-json process 並保持住，閒置一段時間後關閉 port，整串 process 就跟著結束。
- MV3 service worker 生命週期與 port 的互動，這份文件沒有寫；另一張 ticket 處理 Chrome 端架構時要再查。
- 替代方案：bridge 起 `127.0.0.1` HTTP server，外掛用 `fetch`。但「誰去啟動 server」還是要靠 Native Messaging 或使用者手動執行，所以 Native Messaging 仍然是按需啟動最乾淨的方式。

## 6. 其他整合（簡述）

- **Remote Control**：把本機 session 接到 claude.ai/code 或手機 App 讓人類操作，可以附圖，但沒有給第三方程式用的 API。[remote-control](https://code.claude.com/docs/en/remote-control.md)
- **Background sessions / `claude agents` / `claude attach`**：`--bg` 可以開背景 session，`claude agents --json` 能列出 session。但送訊息給背景 session 還是要走 cross-session messaging，限制同 1a。[cli-reference](https://code.claude.com/docs/en/cli-reference.md)
- **Claude in Chrome（`--chrome`）**：方向相反，是 Claude 操作瀏覽器，不是外掛呼叫 Claude。不適用。

## 建議（給後續 ADR 參考）

1. **主路徑**：Chrome 外掛 →（Native Messaging，按需 `connectNative`）→ 本機 bridge（Node）→ 常駐的 `claude -p --input-format stream-json --output-format stream-json`（或 Agent SDK `query()` 的 streaming input），送出 base64 Page 圖片並要求 `--json-schema` 結構化輸出，閒置後自動關閉。
2. **啟動旗標**：`--model <待 spike 決定> --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence`（需要 Series Notes tool 時才加 `--mcp-config`）。不要設定 `ANTHROPIC_API_KEY`，否則會繞過訂閱。
3. **併發**：一個 claude process 一次處理一個請求（會排隊）。預翻好幾頁時開 N 個 process 組成 pool，N 由用量與延遲實驗決定。
4. **用量量測**：`result` 訊息裡的 `usage`、`modelUsage`、`duration_api_ms` 可以直接記錄成每頁延遲與用量（`total_cost_usd` 是用 API 牌價估的，訂閱實際不扣錢，但可以當成相對指標）。
5. **不採用**：inbox socket（只能純文字、協定未公開）、Channels（要常駐互動 session + dev flag，`-p` 下無效）、`--bare`（不支援訂閱）、MCP poll（浪費額度）。

## 未解問題

- MV3 service worker 被回收時，`connectNative` 的 port 與 host 的行為（交給 Chrome 架構相關的 ticket）。
- 真實漫畫 Page（大圖、直書）在不同模型下的延遲與 token 用量（交給 vision / OCR 的 spike）。
- 訂閱的 rate limit 在大量預翻時的表現：文件只說 limits 假設的是「ordinary, individual usage」，沒有具體數字。
