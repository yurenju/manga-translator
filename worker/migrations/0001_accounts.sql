-- Account 與 email 驗證碼登入（#91）。時間一律是 Unix 毫秒；OTP 與 session token 只存 SHA-256 hash。

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- 每個 email 同時只有一組有效的驗證碼：重新寄送就整列換掉、嘗試次數歸零
CREATE TABLE otps (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- 每次使用都更新 last_used_at；超過閒置期限或 revoked_at 有值就失效
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX sessions_account ON sessions(account_id);
