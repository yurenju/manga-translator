/**
 * Subscription（spec #86「額度規則」、#94）：把 Paddle 的 subscription.* webhook 寫進 D1，以及每月週期怎麼算。
 * D1 schema 在 worker/migrations/0003_subscriptions.sql。扣額度在 quota.ts。
 */

/** 有權限的狀態：active（包含排定取消）與 past_due（Paddle 重試扣款中）。canceled、paused 之後回到只剩 Free Pages。 */
const ENTITLED = ['active', 'past_due'] as const;

export interface Subscription {
  status: (typeof ENTITLED)[number];
  /** 訂閱開始時間：每月週期的錨點。 */
  startedAt: number;
  periodEndsAt: number;
  cancelScheduled: boolean;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
}

interface Row {
  status: string;
  started_at: number;
  period_ends_at: number | null;
  cancel_scheduled: number;
  paddle_subscription_id: string;
  paddle_customer_id: string;
}

const isEntitled = (status: string): status is Subscription['status'] => (ENTITLED as readonly string[]).includes(status);

/** 這個 Account 有權限的訂閱；沒訂閱過、或已經結束就是 undefined。 */
export async function activeSubscription(db: D1Database, accountId: string): Promise<Subscription | undefined> {
  const row = await db.prepare('SELECT * FROM subscriptions WHERE account_id = ?').bind(accountId).first<Row>();
  if (!row || !isEntitled(row.status)) return undefined;
  return {
    status: row.status,
    startedAt: row.started_at,
    // 有權限的訂閱一定有目前的扣款週期；萬一沒有，就當作從開始日起一年
    periodEndsAt: row.period_ends_at ?? addMonths(row.started_at, 12),
    cancelScheduled: row.cancel_scheduled === 1,
    paddleSubscriptionId: row.paddle_subscription_id,
    paddleCustomerId: row.paddle_customer_id,
  };
}

/** 這個 Account 的 Paddle customer 與 subscription id（管理訂閱用）；訂閱結束後也還在，才能看收據。 */
export async function paddleIds(db: D1Database, accountId: string): Promise<{ customerId: string; subscriptionId: string } | undefined> {
  const row = await db
    .prepare('SELECT paddle_customer_id, paddle_subscription_id FROM subscriptions WHERE account_id = ?')
    .bind(accountId)
    .first<Pick<Row, 'paddle_customer_id' | 'paddle_subscription_id'>>();
  return row ? { customerId: row.paddle_customer_id, subscriptionId: row.paddle_subscription_id } : undefined;
}

/** anchor 往後 n 個月的同一天同一時刻（UTC）；那個月沒有那一天就是月底。每次都從錨點算，31 號的訂閱 2 月底之後回到 3 月 31 日。 */
function addMonths(anchor: number, n: number): number {
  const d = new Date(anchor);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + n;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** now 所在的本月週期：起點與下次重置的時間。週期由開始日自己算，不依賴 Paddle 的扣款週期（一年只扣一次）。 */
export function monthlyCycle(anchor: number, now: number): { start: number; resetsAt: number } {
  const a = new Date(anchor);
  const b = new Date(now);
  let n = Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth());
  if (n > 0 && addMonths(anchor, n) > now) n--;
  return { start: addMonths(anchor, n), resetsAt: addMonths(anchor, n + 1) };
}

const time = (value: unknown): number | undefined => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * 套用一個已經驗過簽章的 Paddle 事件。只看 subscription.*，其他事件（transaction.completed 等）不做事。
 * - Account 來自 custom_data.account_id（Worker 建立 transaction 時放的，Paddle 帶到 subscription 上）；沒有的話用 subscription id 找已經存在的那一列
 * - 用 event_id 去重；用 occurred_at 判斷新舊，比已經套用的事件舊就不覆蓋
 */
export async function applyPaddleEvent(db: D1Database, event: unknown, now: number): Promise<void> {
  const e = object(event);
  const eventId = text(e.event_id);
  const occurredAt = time(e.occurred_at);
  if (!eventId || occurredAt === undefined || !text(e.event_type)?.startsWith('subscription.')) return;
  if (await db.prepare('SELECT 1 FROM paddle_events WHERE event_id = ?').bind(eventId).first()) return;

  const data = object(e.data);
  const subscriptionId = text(data.id);
  const customerId = text(data.customer_id);
  const status = text(data.status);
  const startedAt = time(data.started_at) ?? time(object(data.current_billing_period).starts_at) ?? occurredAt;
  if (!subscriptionId || !customerId || !status) return;
  const accountId = await owner(db, text(object(data.custom_data).account_id), subscriptionId);
  if (!accountId) return;

  await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (account_id, paddle_subscription_id, paddle_customer_id, status, started_at, period_ends_at, cancel_scheduled, event_occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           paddle_subscription_id = excluded.paddle_subscription_id, paddle_customer_id = excluded.paddle_customer_id, status = excluded.status,
           started_at = excluded.started_at, period_ends_at = excluded.period_ends_at, cancel_scheduled = excluded.cancel_scheduled,
           event_occurred_at = excluded.event_occurred_at
         WHERE excluded.event_occurred_at > subscriptions.event_occurred_at`,
      )
      .bind(
        accountId,
        subscriptionId,
        customerId,
        status,
        startedAt,
        time(object(data.current_billing_period).ends_at) ?? null,
        text(object(data.scheduled_change).action) === 'cancel' ? 1 : 0,
        occurredAt,
      ),
    db.prepare('INSERT INTO paddle_events (event_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(eventId, now),
  ]);
}

/** 事件屬於哪個 Account：custom_data 的 id 要是存在的 Account（刪除帳號後的事件就不套用）。 */
async function owner(db: D1Database, fromCustomData: string | undefined, subscriptionId: string): Promise<string | undefined> {
  if (fromCustomData) {
    const account = await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(fromCustomData).first<{ id: string }>();
    return account?.id;
  }
  const row = await db.prepare('SELECT account_id FROM subscriptions WHERE paddle_subscription_id = ?').bind(subscriptionId).first<{ account_id: string }>();
  return row?.account_id;
}
