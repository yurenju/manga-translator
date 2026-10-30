import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

// Worker 的 HTTP 測試（spec #86 接縫一）：在 workerd 裡跑真正的 Worker 與本機 D1，Anthropic 用 vi.spyOn(fetch) 假的。
// 用 env.dev（真的 Claude 路徑），key 換成假的，萬一沒攔到 fetch 也只會拿到 401。寄信是 env.dev 的假實作（FAKE_MAIL）。
// migrations 在 Node 這邊讀出來，交給 setup 檔在每個測試檔開始前套用。
const migrations = await readD1Migrations(join(dirname(fileURLToPath(import.meta.url)), 'migrations'));

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: { bindings: { CLAUDE_API_KEY: 'sk-ant-worker-test', TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/apply-migrations.ts'],
  },
});
