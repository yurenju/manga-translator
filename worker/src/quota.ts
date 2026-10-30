/**
 * 額度（spec #86「額度規則」、#92）：新 Account 有一次性的 Free Pages。D1 schema 在 worker/migrations/0002_free_pages.sql。
 * 訂閱與 Monthly Page Limit 由 #94 接上。
 */
import type { Quota } from '../../src/shared/hosted-api.ts';
import type { Usage } from '../../src/shared/translator.ts';
import { sha256 } from './hash.ts';

/** 新 Account 一次性的免費頁數。 */
export const FREE_PAGES = 50;

/** 新 Account 的 Free Pages：這個 email 沒領過才給 FREE_PAGES 頁，領過（刪除帳號後重新註冊）就是 0。 */
export async function grantFreePages(db: D1Database, accountId: string, email: string, now: number): Promise<void> {
  const grant = await db.prepare('INSERT INTO free_page_grants (email_hash, granted_at) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(await sha256(email), now).run();
  await db.prepare('INSERT INTO quotas (account_id, free_pages) VALUES (?, ?)').bind(accountId, grant.meta.changes === 1 ? FREE_PAGES : 0).run();
}

export async function quota(db: D1Database, accountId: string): Promise<Quota> {
  const row = await db.prepare('SELECT free_pages FROM quotas WHERE account_id = ?').bind(accountId).first<{ free_pages: number }>();
  return { plan: 'free', remaining: row?.free_pages ?? 0 };
}

/** 扣一個 Translated Page。條件式 UPDATE 一次做完「還有沒有、扣掉」，不先讀再寫；false＝已經沒有了。 */
export async function deductPage(db: D1Database, accountId: string): Promise<boolean> {
  const result = await db.prepare('UPDATE quotas SET free_pages = free_pages - 1 WHERE account_id = ? AND free_pages > 0').bind(accountId).run();
  return result.meta.changes === 1;
}

export type UsageKind = 'translate' | 'notes';

/** 一次 Anthropic 呼叫的用量：只有時間、種類、tokens 與成本，不存任何內容。 */
export async function recordUsage(db: D1Database, accountId: string, kind: UsageKind, usage: Usage, now: number): Promise<void> {
  await db
    .prepare('INSERT INTO usage_records (account_id, created_at, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(accountId, now, kind, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.costUsd)
    .run();
}

/** 開發用：直接設定這個 email 的 Account 的免費額度；沒有這個 Account 就是 false。 */
export async function setFreePages(db: D1Database, email: string, remaining: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE quotas SET free_pages = ? WHERE account_id = (SELECT id FROM accounts WHERE email = ?)')
    .bind(remaining, email)
    .run();
  return result.meta.changes === 1;
}
