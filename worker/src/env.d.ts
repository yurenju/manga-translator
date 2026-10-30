/** wrangler.jsonc 的 define：env.test 是 true，Anthropic 換成 FakeTranslator；其他是 false，整段不會打包。 */
declare const __FAKE_ANTHROPIC__: boolean;

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** "true"：接受 DEV_SESSION_TOKEN（只有 env.dev／env.test 設）。 */
    ALLOW_DEV_TOKEN?: string;
    /** 呼叫 Anthropic 的 key：production 用 wrangler secret，本機放 worker/.dev.vars。 */
    CLAUDE_API_KEY?: string;
  }

  /** 讓測試的 `exports.default`（cloudflare:workers）有 Worker 入口的型別。 */
  interface GlobalProps {
    mainModule: typeof import('./index.ts');
  }
}
