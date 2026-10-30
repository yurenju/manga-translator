/**
 * Hosted Translation 的後端（ADR 0006）：外掛送這一頁的結構化輸入，Worker 用共用模組 claude-request.ts
 * 組 prompt、用公司的 key 呼叫 Anthropic。只收文字、不保存任何漫畫內容。
 * #90 只驗證開發用 token；Account、額度、Paddle 由 #91 起接上。
 */
import { SYNTHETIC_GROUND_TRUTH } from '../../src/background/synthetic-ground-truth.ts';
import { createClaudeTranslator } from '../../src/offscreen/claude-translator.ts';
import { createFakeTranslator } from '../../src/shared/fake-translator.ts';
import { DEV_SESSION_TOKEN, NOTES_PATH, TRANSLATE_PATH, type HostedError } from '../../src/shared/hosted-api.ts';
import type { Translator } from '../../src/shared/translator.ts';
import { parseNotesInput, parseTranslateInput } from './input.ts';

type Env = Cloudflare.Env;

/** Authorization: Bearer <token>。#90 只認開發用 token，而且要 ALLOW_DEV_TOKEN。 */
function authorized(request: Request, env: Env): boolean {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  return env.ALLOW_DEV_TOKEN === 'true' && token === DEV_SESSION_TOKEN;
}

const error = (status: number, message: string) => Response.json({ error: message } satisfies HostedError, { status });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** env.test（browser test）用 FakeTranslator 取代 Anthropic；其他用 Worker 的 key 呼叫 Claude，429／5xx 的重試在 claude-translator.ts。 */
function translator(env: Env): Translator {
  if (__FAKE_ANTHROPIC__) return createFakeTranslator(SYNTHETIC_GROUND_TRUTH);
  return createClaudeTranslator({ apiKey: env.CLAUDE_API_KEY ?? '', fetch: (url, init) => fetch(url, init), sleep, now: () => Date.now() });
}

/**
 * 每個端點：先把 body 整理成只含已知欄位的輸入（client 送的 model、max_tokens、system 之類一律不看），
 * 再交給 Translator；request body 由 Translator 裡的 claude-request.ts 組。
 */
const ROUTES: Record<string, (body: unknown, translator: Translator) => Promise<object> | undefined> = {
  [TRANSLATE_PATH]: (body, t) => {
    const input = parseTranslateInput(body);
    return input && t.translatePage(input);
  },
  [NOTES_PATH]: (body, t) => {
    const input = parseNotesInput(body);
    return input && t.proposeNotes(input);
  },
};

export default {
  async fetch(request, env) {
    const route = ROUTES[new URL(request.url).pathname];
    if (!route || request.method !== 'POST') return error(404, '沒有這個端點');
    if (!authorized(request, env)) return error(401, '請先登入');
    const body = await request.json().catch(() => undefined);
    const call = route(body, translator(env));
    if (!call) return error(400, '輸入格式不符');
    try {
      return Response.json(await call);
    } catch (e) {
      // Anthropic 重試後仍失敗，或回答不符合 schema
      return error(502, e instanceof Error ? e.message : String(e));
    }
  },
} satisfies ExportedHandler<Env>;
