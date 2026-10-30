-- Notes 的用量歸到同一頁（spec #86「Worker API」：Notes 記錄用量，成本歸到這一頁）。
-- Notes 那筆用量紀錄記下同一頁翻譯那筆的 id（同一個 Account 的 translate 紀錄才記，否則 NULL）；翻譯紀錄自己是 NULL。只有 id，不存內容。
ALTER TABLE usage_records ADD COLUMN page_record_id INTEGER;
