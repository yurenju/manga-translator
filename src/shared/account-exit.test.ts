import { describe, expect, it } from 'vitest';
import { setupNotices } from '../ui/view.ts';
import { deleteAccount, signOut, type AccountExitDeps } from './account-exit.ts';
import type { AuthFailure } from './hosted-account-client.ts';
import type { HostedSession } from './hosted-session.ts';

const failure = (reason: AuthFailure['reason'], message = '失敗'): AuthFailure => ({ ok: false, reason, message });

/** 本機的 session 與廣播都記在記憶體；Worker 的回應由測試指定。 */
function fakeDeps(worker: { signOut?: AuthFailure; deleteAccount?: AuthFailure } = {}) {
  let session: HostedSession | null = { token: 't1', email: 'reader@example.com' };
  const calls: string[] = [];
  const deps: AccountExitDeps = {
    auth: {
      signOut: async (token) => (calls.push(`signOut ${token}`), worker.signOut ?? { ok: true }),
      deleteAccount: async (token) => (calls.push(`deleteAccount ${token}`), worker.deleteAccount ?? { ok: true }),
    },
    clearSession: async () => {
      session = null;
    },
    broadcast: () => calls.push('session:changed'),
  };
  const panelNotice = () => setupNotices({ access: { mode: 'hosted', signedIn: session !== null }, consented: true, untranslated: false }).notice;
  return { deps, calls, session: () => session, panelNotice };
}

describe('登出', () => {
  it('撤銷這個 token、清掉本機的 session 並廣播；side panel 回到「尚未登入」', async () => {
    const { deps, calls, session, panelNotice } = fakeDeps();

    await signOut(deps, 't1');

    expect(calls).toEqual(['signOut t1', 'session:changed']);
    expect(session()).toBeNull();
    expect(panelNotice()).toBe('signedOut');
  });

  it('連不上 Worker 也一樣登出（本機不留 token）', async () => {
    const { deps, session } = fakeDeps({ signOut: failure(undefined, 'Failed to fetch') });

    await signOut(deps, 't1');

    expect(session()).toBeNull();
  });
});

describe('刪除帳號', () => {
  it('Worker 刪除成功：清掉本機的 session 並廣播', async () => {
    const { deps, calls, session, panelNotice } = fakeDeps();

    expect(await deleteAccount(deps, 't1')).toEqual({ ok: true });

    expect(calls).toEqual(['deleteAccount t1', 'session:changed']);
    expect(session()).toBeNull();
    expect(panelNotice()).toBe('signedOut');
  });

  it('Worker 失敗（例如取消訂閱失敗）：保留登入狀態，回傳錯誤讓讀者再試一次', async () => {
    const { deps, calls, session } = fakeDeps({ deleteAccount: failure(undefined, '付款服務暫時無法使用') });

    expect(await deleteAccount(deps, 't1')).toEqual(failure(undefined, '付款服務暫時無法使用'));

    expect(calls).toEqual(['deleteAccount t1']);
    expect(session()).not.toBeNull();
  });

  it('token 已經失效（signedOut）：當作已經登出，清掉本機的 session', async () => {
    const { deps, session } = fakeDeps({ deleteAccount: failure('signedOut') });

    expect(await deleteAccount(deps, 't1')).toEqual({ ok: true });

    expect(session()).toBeNull();
  });
});
