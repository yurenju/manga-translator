/**
 * email 驗證碼登入的 client（#91）：side panel 的登入畫面（之後是 onboarding 的登入步驟，#93）呼叫 Worker 寄送與驗證驗證碼。
 * 回傳 Worker 給的錯誤原因，畫面依原因換文案；連不上 Worker 時 reason 是 undefined。
 */
import { SEND_CODE_PATH, VERIFY_CODE_PATH, type HostedError, type HostedErrorReason, type VerifyCodeResponse } from './hosted-api.ts';

export type AuthFailure = { ok: false; reason: HostedErrorReason | undefined; message: string };

export interface HostedAuth {
  sendCode(email: string): Promise<{ ok: true } | AuthFailure>;
  verifyCode(email: string, code: string): Promise<{ ok: true; token: string } | AuthFailure>;
}

export function createHostedAuth({ apiUrl, fetch }: { apiUrl: string; fetch: (url: string, init: RequestInit) => Promise<Response> }): HostedAuth {
  async function post(path: string, body: unknown): Promise<{ ok: true; response: Response } | AuthFailure> {
    let response: Response;
    try {
      response = await fetch(apiUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      return { ok: false, reason: undefined, message: e instanceof Error ? e.message : String(e) };
    }
    if (response.ok) return { ok: true, response };
    const error = (await response.json().catch(() => ({}))) as Partial<HostedError>;
    return { ok: false, reason: error.reason, message: error.error ?? `HTTP ${response.status}` };
  }

  return {
    async sendCode(email) {
      const result = await post(SEND_CODE_PATH, { email });
      return result.ok ? { ok: true } : result;
    },
    async verifyCode(email, code) {
      const result = await post(VERIFY_CODE_PATH, { email, code });
      if (!result.ok) return result;
      const { token } = (await result.response.json()) as VerifyCodeResponse;
      return { ok: true, token };
    },
  };
}
