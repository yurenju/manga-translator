-- Free Pages 與用量紀錄（#92）。時間一律是 Unix 毫秒。

-- 領過 Free Pages 的 email（SHA-256 hash）：刪除帳號後仍保留，同一個 email 重新註冊不會再領一次
CREATE TABLE free_page_grants (
  email_hash TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL
);

-- 每個 Account 的額度；扣額度一律用條件式 UPDATE ... WHERE free_pages > 0（#94 在這裡加當月週期的欄位）
CREATE TABLE quotas (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  free_pages INTEGER NOT NULL CHECK (free_pages >= 0)
);

-- 每次成功的 Anthropic 呼叫一筆：只有數字，不存原文、譯文、Series 名稱或網址
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('translate', 'notes')),
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);

CREATE INDEX usage_records_account ON usage_records(account_id, created_at);
