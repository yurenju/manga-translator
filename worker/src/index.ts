/**
 * Hosted Translation 的後端（ADR 0006）：讀者用 email 驗證碼登入（auth.ts），外掛帶 session token 送這一頁的結構化輸入，
 * Worker 用共用模組 claude-request.ts 組 prompt、用公司的 key 呼叫 Anthropic。只收文字、不保存任何漫畫內容。
 * 路徑與錯誤格式在 src/shared/hosted-api.ts；額度、Paddle 由 #92 起接上。
 */
import { SYNTHETIC_GROUND_TRUTH } from '../../src/background/synthetic-ground-truth.ts';
import { createClaudeTranslator } from '../../src/offscreen/claude-translator.ts';
import { createFakeTranslator } from '../../src/shared/fake-translator.ts';
import {
  ACCOUNT_PATH,
  DEV_OUTBOX_PATH,
  NOTES_PATH,
  SEND_CODE_PATH,
  SIGN_OUT_PATH,
  TRANSLATE_PATH,
  VERIFY_CODE_PATH,
  type AccountResponse,
  type HostedError,
  type HostedErrorReason,
  type VerifyCodeResponse,
} from '../../src/shared/hosted-api.ts';
import type { Translator } from '../../src/shared/translator.ts';
import { accountEmail, authenticate, revokeSession, sendCode, verifyCode } from './auth.ts';
import { parseNotesInput, parseTranslateInput } from './input.ts';
import { lastSentCode, mailer } from './mailer.ts';

type Env = Cloudflare.Env;

const error = (status: number, message: string, reason?: HostedErrorReason) =>
  Response.json({ error: message, ...(reason ? { reason } : {}) } satisfies HostedError, { status });

const signedOut = () => error(401, '請先登入', 'signedOut');
const invalid = () => error(400, '輸入格式不符');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** env.test（browser test）用 FakeTranslator 取代 Anthropic；其他用 Worker 的 key 呼叫 Claude，429／5xx 的重試在 claude-translator.ts。 */
function translator(env: Env): Translator {
  if (__FAKE_ANTHROPIC__) return createFakeTranslator(SYNTHETIC_GROUND_TRUTH);
  return createClaudeTranslator({ apiKey: env.CLAUDE_API_KEY ?? '', fetch: (url, init) => fetch(url, init), sleep, now: () => Date.now() });
}

/** email 一律去空白、轉小寫；不像 email 就是 undefined。 */
function parseEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

const field = (body: unknown, key: string): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined);

const bearer = (request: Request) => request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];

interface Context {
  request: Request;
  env: Env;
  now: number;
}

type Handler = (ctx: Context) => Promise<Response>;
/** 要登入的端點：多拿到 session token 對應的 Account id。 */
type AuthedHandler = (ctx: Context, accountId: string) => Promise<Response>;

/** 先驗 session token（每次使用都延長期限），沒登入回 401 signedOut。 */
const authed =
  (handler: AuthedHandler): Handler =>
  async (ctx) => {
    const token = bearer(ctx.request);
    const accountId = token && (await authenticate(ctx.env.DB, token, ctx.now));
    return accountId ? handler(ctx, accountId) : signedOut();
  };

/**
 * 翻譯與 Notes：先把 body 整理成只含已知欄位的輸入（client 送的 model、max_tokens、system 之類一律不看），
 * 再交給 Translator；request body 由 Translator 裡的 claude-request.ts 組。
 */
const llm =
  (call: (body: unknown, t: Translator) => Promise<object> | undefined): Handler =>
  async ({ request, env }) => {
    const pending = call(await request.json().catch(() => undefined), translator(env));
    if (!pending) return invalid();
    try {
      return Response.json(await pending);
    } catch (e) {
      // Anthropic 重試後仍失敗，或回答不符合 schema
      return error(502, e instanceof Error ? e.message : String(e));
    }
  };

const VERIFY_ERRORS = {
  wrongCode: '驗證碼不正確',
  codeExpired: '驗證碼已經過期',
  tooManyAttempts: '錯誤次數太多，這組驗證碼已失效',
} as const;

const ROUTES: Record<string, Handler> = {
  [`POST ${TRANSLATE_PATH}`]: authed(
    llm((body, t) => {
      const input = parseTranslateInput(body);
      return input && t.translatePage(input);
    }),
  ),
  [`POST ${NOTES_PATH}`]: authed(
    llm((body, t) => {
      const input = parseNotesInput(body);
      return input && t.proposeNotes(input);
    }),
  ),
  [`POST ${SEND_CODE_PATH}`]: async ({ request, env, now }) => {
    const email = parseEmail(field(await request.json().catch(() => undefined), 'email'));
    if (!email) return invalid();
    // 兩個都要過：換 IP 不能對同一個信箱一直寄，同一個 IP 也不能換信箱一直寄
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const [byIp, byEmail] = await Promise.all([env.SEND_CODE_BY_IP.limit({ key: ip }), env.SEND_CODE_BY_EMAIL.limit({ key: email })]);
    if (!byIp.success || !byEmail.success) return error(429, '寄送太頻繁', 'rateLimited');
    await sendCode(env.DB, mailer(env), email, now);
    return new Response(null, { status: 204 });
  },
  [`POST ${VERIFY_CODE_PATH}`]: async ({ request, env, now }) => {
    const body = await request.json().catch(() => undefined);
    const email = parseEmail(field(body, 'email'));
    const code = field(body, 'code');
    if (!email || typeof code !== 'string') return invalid();
    const result = await verifyCode(env.DB, email, code.trim(), now);
    if (!result.ok) return error(400, VERIFY_ERRORS[result.reason], result.reason);
    return Response.json({ token: result.token } satisfies VerifyCodeResponse);
  },
  [`POST ${SIGN_OUT_PATH}`]: authed(async ({ request, env, now }) => {
    await revokeSession(env.DB, bearer(request)!, now);
    return new Response(null, { status: 204 });
  }),
  [`GET ${ACCOUNT_PATH}`]: authed(async ({ env }, accountId) => {
    const email = await accountEmail(env.DB, accountId);
    return email ? Response.json({ email } satisfies AccountResponse) : signedOut();
  }),
  [`GET ${DEV_OUTBOX_PATH}`]: async ({ request, env }) => {
    if (env.FAKE_MAIL !== 'true') return error(404, '沒有這個端點');
    const email = parseEmail(new URL(request.url).searchParams.get('email'));
    const code = email && lastSentCode(email);
    return code ? Response.json({ code }) : error(404, '沒有寄給這個 email 的驗證碼');
  },
};

export default {
  async fetch(request, env) {
    const route = ROUTES[`${request.method} ${new URL(request.url).pathname}`];
    if (!route) return error(404, '沒有這個端點');
    return route({ request, env, now: Date.now() });
  },
} satisfies ExportedHandler<Env>;
