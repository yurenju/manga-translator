-- 猜驗證碼的限制。時間一律是 Unix 毫秒。

-- 每個 email（SHA-256 hash）在一個時間窗內驗證了幾次：重新寄送驗證碼不會歸零，所以不能靠一直重寄無限猜。
-- 每次驗證先加一再比對；登入成功、刪除帳號時刪掉這一列，時間窗過了的列在有人寄驗證碼時一起刪掉。
CREATE TABLE verify_attempts (
  email_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
