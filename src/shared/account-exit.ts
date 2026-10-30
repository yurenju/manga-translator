/**
 * 登出與刪除帳號（#95）：呼叫 Worker → 清掉本機的 session → 廣播 `session:changed`，side panel 回到「尚未登入」。
 * 本機的翻譯快取、Series Notes、資料使用同意都不動。
 */
import type { AuthFailure, HostedAuth } from './hosted-auth.ts';

export interface AccountExitDeps {
  auth: Pick<HostedAuth, 'signOut' | 'deleteAccount'>;
  clearSession: () => Promise<void>;
  broadcast: () => void;
}

async function forget({ clearSession, broadcast }: AccountExitDeps): Promise<void> {
  await clearSession();
  broadcast();
}

/** 登出：Worker 撤銷這個 token；連不上 Worker 也照樣清掉本機的 token（讀者要的是這台電腦不再登入）。 */
export async function signOut(deps: AccountExitDeps, token: string): Promise<void> {
  await deps.auth.signOut(token);
  await forget(deps);
}

/**
 * 刪除帳號：Worker 刪除成功才清掉本機的 session；失敗（例如取消 Paddle 訂閱失敗）就保留登入，讓讀者再試一次。
 * token 已經失效（signedOut）時帳號查不到了，當作已經登出。
 */
export async function deleteAccount(deps: AccountExitDeps, token: string): Promise<{ ok: true } | AuthFailure> {
  const result = await deps.auth.deleteAccount(token);
  if (!result.ok && result.reason !== 'signedOut') return result;
  await forget(deps);
  return { ok: true };
}
