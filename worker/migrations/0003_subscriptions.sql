-- Subscription 與 Monthly Page Limit（#94）。時間一律是 Unix 毫秒。

-- 每個 Account 一列，由 Paddle 的 subscription.* webhook 寫入（Paddle 是唯一的來源，外掛與 client 寫不到）。
-- event_occurred_at 是最後套用的事件的 occurred_at：比它舊的事件不能覆蓋（送達順序可能顛倒）。
-- period_ends_at 是目前這一年的結束（Paddle 的 current_billing_period.ends_at）；canceled 之後 Paddle 不給，是 NULL。
CREATE TABLE subscriptions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  paddle_subscription_id TEXT NOT NULL,
  paddle_customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  period_ends_at INTEGER,
  cancel_scheduled INTEGER NOT NULL CHECK (cancel_scheduled IN (0, 1)),
  event_occurred_at INTEGER NOT NULL
);

CREATE INDEX subscriptions_paddle_id ON subscriptions(paddle_subscription_id);

-- 處理過的 webhook 事件（Paddle 的 event_id）：重送的事件只套用一次
CREATE TABLE paddle_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

-- 訂閱中的本月用量：cycle_start 是本月週期的起點（從訂閱開始日算），跟現在的週期不一樣就代表已經重置、用量從 0 算。
-- 扣額度一律用條件式 UPDATE 一次做完「換週期或檢查還有沒有、扣掉」。
ALTER TABLE quotas ADD COLUMN cycle_start INTEGER;
ALTER TABLE quotas ADD COLUMN cycle_used INTEGER NOT NULL DEFAULT 0;
