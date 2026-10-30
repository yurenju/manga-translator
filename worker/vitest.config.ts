import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';

// Worker 的 HTTP 測試（spec #86 接縫一）：在 workerd 裡跑真正的 Worker 與本機 D1，Anthropic 用 vi.spyOn(fetch) 假的。
// 用 env.dev（真的 Claude 路徑），key 換成假的，萬一沒攔到 fetch 也只會拿到 401。
export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: { bindings: { CLAUDE_API_KEY: 'sk-ant-worker-test' } },
    }),
  ],
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts'],
  },
});
