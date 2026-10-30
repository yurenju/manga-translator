/** wrangler.jsonc 的 define：env.test 是 true，Anthropic 換成 FakeTranslator；其他是 false，整段不會打包。 */
declare const __FAKE_ANTHROPIC__: boolean;

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** 寄送驗證碼的頻率限制（Workers Rate Limiting），key 分別是 IP 與 email。 */
    SEND_CODE_BY_IP: RateLimit;
    SEND_CODE_BY_EMAIL: RateLimit;
    /** "true"：寄信用假的實作，並開放 DEV_OUTBOX_PATH（只有 env.dev／env.test 設）。 */
    FAKE_MAIL?: string;
    /** Resend 的 key 與寄件地址：production 用 wrangler secret／vars（#97）。 */
    RESEND_API_KEY?: string;
    MAIL_FROM?: string;
    /** 呼叫 Anthropic 的 key：production 用 wrangler secret，本機放 worker/.dev.vars。 */
    CLAUDE_API_KEY?: string;
  }

  /** 讓測試的 `exports.default`（cloudflare:workers）有 Worker 入口的型別。 */
  interface GlobalProps {
    mainModule: typeof import('./index.ts');
  }
}
