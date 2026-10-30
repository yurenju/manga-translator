/**
 * Hosted Translation 的後端（ADR 0006）：讀者用 email 驗證碼登入（auth.ts），外掛帶 session token 送這一頁的結構化輸入，
 * Worker 用共用模組 claude-request.ts 組 prompt、用公司的 key 呼叫 Anthropic。只收文字、不保存任何漫畫內容。
 * 路徑與錯誤格式在 src/shared/hosted-api.ts；額度在 quota.ts，Paddle API 與 webhook 簽章在 paddle.ts，訂閱狀態在 subscription.ts。
 */
import { SYNTHETIC_GROUND_TRUTH } from '../../src/background/synthetic-ground-truth.ts';
import { createClaudeTranslator } from '../../src/offscreen/claude-translator.ts';
import { createFakeTranslator } from '../../src/shared/fake-translator.ts';
import {
  ACCOUNT_PATH,
  CHECKOUT_PATH,
  DEV_FREE_PAGES_PATH,
  DEV_OUTBOX_PATH,
  NOTES_PATH,
  PADDLE_WEBHOOK_PATH,
  PORTAL_PATH,
  SEND_CODE_PATH,
  SIGN_OUT_PATH,
  TRANSLATE_PATH,
  VERIFY_CODE_PATH,
  type AccountResponse,
  type CheckoutLocale,
  type CheckoutResponse,
  type HostedError,
  type HostedErrorReason,
  type PortalResponse,
  type Quota,
  type VerifyCodeResponse,
} from '../../src/shared/hosted-api.ts';
import type { CallInfo, Translator } from '../../src/shared/translator.ts';
import { accountEmail, authenticate, revokeSession, sendCode, verifyCode } from './auth.ts';
import { deductPage, monthlyLimit, quota, recordUsage, setFreePages, type QuotaClock, type UsageKind } from './quota.ts';
import { parseNotesInput, parseTranslateInput } from './input.ts';
import { lastSentCode, mailer } from './mailer.ts';
import { paddle, PaddleError, verifyWebhook } from './paddle.ts';
import { activeSubscription, applyPaddleEvent, paddleIds } from './subscription.ts';

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

/** 額度用完：沒訂閱是免費額度用完，訂閱中是本月額度用完（重置日期由外掛重讀 GET /v1/account）。 */
const exhausted = (plan: Quota['plan']) =>
  plan === 'free' ? error(402, '免費額度已用完', 'freePagesExhausted') : error(402, '本月額度已用完', 'monthlyLimitReached');

const clock = (env: Env, now: number): QuotaClock => ({ now, limit: monthlyLimit(env) });

/**
 * 翻譯與 Notes：先把 body 整理成只含已知欄位的輸入（client 送的 model、max_tokens、system 之類一律不看），
 * 再交給 Translator；request body 由 Translator 裡的 claude-request.ts 組。
 * 翻譯（spec #86「額度規則」）：送出前先看還有沒有額度，成功後才用條件式 UPDATE 扣一頁；同時送來的兩頁搶最後一頁時，
 * 扣不到的那個回 402（譯文丟掉）。Notes 不扣。成功的呼叫都寫一筆用量紀錄，扣不到的那次也算（Anthropic 的錢已經花了）。
 */
const llm =
  <I,>(kind: UsageKind, parse: (body: unknown) => I | undefined, run: (t: Translator, input: I) => Promise<CallInfo>): AuthedHandler =>
  async ({ request, env, now }, accountId) => {
    const input = parse(await request.json().catch(() => undefined));
    if (input === undefined) return invalid();
    const charged = kind === 'translate';
    if (charged) {
      const before = await quota(env.DB, accountId, clock(env, now));
      if (before.remaining === 0) return exhausted(before.plan);
    }
    let output: CallInfo;
    try {
      output = await run(translator(env), input);
    } catch (e) {
      // Anthropic 重試後仍失敗，或回答不符合 schema
      return error(502, e instanceof Error ? e.message : String(e));
    }
    await recordUsage(env.DB, accountId, kind, output.usage, now);
    if (charged && !(await deductPage(env.DB, accountId, clock(env, now)))) return exhausted((await quota(env.DB, accountId, clock(env, now))).plan);
    return Response.json(output);
  };

const CHECKOUT_LOCALES: readonly CheckoutLocale[] = ['zh-tw', 'en'];

/** Paddle API 失敗回 502（細節只在 Worker 的 log）；其他錯誤照常往上丟。 */
async function viaPaddle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof PaddleError)) throw e;
    console.error(e.message);
    return error(502, '付款服務暫時無法使用');
  }
}

const VERIFY_ERRORS = {
  wrongCode: '驗證碼不正確',
  codeExpired: '驗證碼已經過期',
  tooManyAttempts: '錯誤次數太多，這組驗證碼已失效',
} as const;

const ROUTES: Record<string, Handler> = {
  [`POST ${TRANSLATE_PATH}`]: authed(llm('translate', parseTranslateInput, (t, input) => t.translatePage(input))),
  [`POST ${NOTES_PATH}`]: authed(llm('notes', parseNotesInput, (t, input) => t.proposeNotes(input))),
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
  [`GET ${ACCOUNT_PATH}`]: authed(async ({ env, now }, accountId) => {
    const email = await accountEmail(env.DB, accountId);
    return email ? Response.json({ email, quota: await quota(env.DB, accountId, clock(env, now)) } satisfies AccountResponse) : signedOut();
  }),
  [`POST ${CHECKOUT_PATH}`]: authed(async ({ request, env }, accountId) => {
    const requested = field(await request.json().catch(() => undefined), 'locale');
    const locale = CHECKOUT_LOCALES.find((l) => l === requested) ?? 'zh-tw';
    if (!env.SITE_ORIGIN) return error(500, '沒有設定產品網站的網址');
    const site = env.SITE_ORIGIN;
    if (await activeSubscription(env.DB, accountId)) return error(409, '已經訂閱中', 'alreadySubscribed');
    return viaPaddle(async () => {
      // Account id 只來自 session token；Paddle 回的 checkout.url 只能是核准過的網域，所以 checkout 網址由 Worker 自己組
      const transactionId = await paddle(env).createTransaction(accountId);
      return Response.json({ url: `${site}/${locale}/checkout?_ptxn=${encodeURIComponent(transactionId)}` } satisfies CheckoutResponse);
    });
  }),
  [`POST ${PORTAL_PATH}`]: authed(async ({ env }, accountId) => {
    const ids = await paddleIds(env.DB, accountId);
    if (!ids) return error(404, '沒有訂閱');
    return viaPaddle(async () => Response.json({ url: await paddle(env).portalUrl(ids.customerId, ids.subscriptionId) } satisfies PortalResponse));
  }),
  // Paddle 的 webhook：先驗簽章（偽造的請求不能把任何人變成訂閱者），再套用；只做幾個 D1 查詢，遠低於 Paddle 要的 5 秒
  [`POST ${PADDLE_WEBHOOK_PATH}`]: async ({ request, env, now }) => {
    const body = await request.text();
    const signature = request.headers.get('paddle-signature') ?? '';
    if (!env.PADDLE_WEBHOOK_SECRET || !(await verifyWebhook(env.PADDLE_WEBHOOK_SECRET, signature, body, now))) return error(401, '簽章不符');
    let event: unknown;
    try {
      event = JSON.parse(body);
    } catch {
      return invalid();
    }
    await applyPaddleEvent(env.DB, event, now);
    return new Response(null, { status: 200 });
  },
  [`GET ${DEV_OUTBOX_PATH}`]: async ({ request, env }) => {
    if (env.FAKE_MAIL !== 'true') return error(404, '沒有這個端點');
    const email = parseEmail(new URL(request.url).searchParams.get('email'));
    const code = email && lastSentCode(email);
    return code ? Response.json({ code }) : error(404, '沒有寄給這個 email 的驗證碼');
  },
  [`POST ${DEV_FREE_PAGES_PATH}`]: async ({ request, env }) => {
    if (env.DEV_ENDPOINTS !== 'true') return error(404, '沒有這個端點');
    const body = await request.json().catch(() => undefined);
    const email = parseEmail(field(body, 'email'));
    const remaining = field(body, 'remaining');
    if (!email || !Number.isInteger(remaining) || (remaining as number) < 0) return invalid();
    return (await setFreePages(env.DB, email, remaining as number)) ? new Response(null, { status: 204 }) : error(404, '沒有這個 Account');
  },
};

export default {
  async fetch(request, env) {
    const route = ROUTES[`${request.method} ${new URL(request.url).pathname}`];
    if (!route) return error(404, '沒有這個端點');
    return route({ request, env, now: Date.now() });
  },
} satisfies ExportedHandler<Env>;
