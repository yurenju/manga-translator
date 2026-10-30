/**
 * Translator 的 Hosted Translation 實作（spec #86、ADR 0006）：把結構化輸入（Lines、Prior Pages、Series Notes）
 * 送到 Worker，帶上 session token。prompt、model、max_tokens 由 Worker 決定，這裡不碰。
 * 在 SW 裡跑：不需要 offscreen document，token 也不經過任何訊息。
 *
 * 重試：429／503 是 Worker 本身忙，等一下再送；502 是 Anthropic 失敗，Worker 已經重試過，這裡不再重試。
 * 401 是 token 已失效（撤銷或閒置太久）：呼叫 onSignedOut 讓外掛回到未登入。
 */
import { NOTES_PATH, TRANSLATE_PATH, type HostedError } from '../shared/hosted-api.ts';
import type { NotesInput, NotesOutput, TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';

const MAX_RETRIES = 3;

export interface HostedDeps {
  /** Worker 的網址（scripts/build.ts 依 build 決定）。 */
  apiUrl: string;
  token: string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** 重試前等待；signal 中止時應該 reject。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /** Worker 說這個 token 已經不能用（401）。 */
  onSignedOut(): void;
}

export function createHostedTranslator(deps: HostedDeps): Translator {
  /** 送出並量延遲（含 Worker 那一段，讀者感受到的就是這個）；Worker 回的 latencyMs 只到 Anthropic，不用。 */
  async function call<T extends { latencyMs: number }>(path: string, input: unknown, signal?: AbortSignal): Promise<T> {
    const started = deps.now();
    for (let attempt = 0; ; attempt++) {
      const response = await deps.fetch(deps.apiUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.token}` },
        body: JSON.stringify(input),
        signal,
      });
      if (response.ok) return { ...((await response.json()) as T), latencyMs: deps.now() - started };
      if (response.status === 401) deps.onSignedOut();
      const retryable = response.status === 429 || response.status === 503;
      if (!retryable || attempt >= MAX_RETRIES) throw new Error(`Hosted Translation ${response.status}：${await errorMessage(response)}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await deps.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 2000, signal);
    }
  }

  return {
    translatePage: (input: TranslateInput, signal?: AbortSignal) => call<TranslateOutput>(TRANSLATE_PATH, input, signal),
    proposeNotes: (input: NotesInput, signal?: AbortSignal) => call<NotesOutput>(NOTES_PATH, input, signal),
  };
}

async function errorMessage(response: Response): Promise<string> {
  try {
    return ((await response.json()) as HostedError).error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
