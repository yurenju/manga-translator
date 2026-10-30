declare namespace Cloudflare {
  interface Env {
    /** 只有測試有：vitest.config.ts 讀好的 worker/migrations。 */
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
