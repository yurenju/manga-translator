import { applyD1Migrations, env } from 'cloudflare:test';

// vitest.config.ts 讀好的 worker/migrations；已經套用過的會跳過
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
